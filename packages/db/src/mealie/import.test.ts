import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { createEmptyDatabase, testServer } from "../test-database.js";
import { createMealieClient, readMealie } from "./client.js";
import { fakeMealie, loadFixture } from "./fake-mealie.js";
import { formatReport, importMealie } from "./import.js";

describe.skipIf(!testServer)("import from Mealie", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let household: string;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    household = (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
  });
  afterAll(async () => {
    await drop();
  });

  const read = async (fixture = loadFixture()) => {
    const { fetch } = fakeMealie({ fixture });
    return readMealie(createMealieClient({ baseUrl: "http://mealie.test", token: "t", fetch }));
  };
  async function counts() {
    const r = await pool.request().input("h", household).query(`
      SELECT (SELECT COUNT(*) FROM food WHERE household_id = @h) AS foods,
             (SELECT COUNT(*) FROM recipe WHERE household_id = @h) AS recipes,
             (SELECT COUNT(*) FROM recipe_ingredient WHERE household_id = @h) AS ingredients,
             (SELECT COUNT(*) FROM recipe_step s JOIN recipe r ON r.id = s.recipe_id WHERE r.household_id = @h) AS steps,
             (SELECT COUNT(*) FROM recipe_tag t JOIN recipe r ON r.id = t.recipe_id WHERE r.household_id = @h) AS tags,
             (SELECT COUNT(*) FROM planned_meal WHERE household_id = @h) AS meals,
             (SELECT COUNT(*) FROM import_source WHERE household_id = @h) AS links`);
    return r.recordset[0];
  }

  it("imports every food, recipe and meal plan entry, and reports what it couldn't map", async () => {
    const report = await importMealie(pool, household, await read());

    // 4 Mealie foods + Garlic, Olive Oil and "salt to taste", which only recipes use. "Flour" and "flour" are one food.
    expect(report.foods).toMatchObject({ created: 4, linked: 0 });
    expect(report.recipes).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(report.mealPlans).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(await counts()).toMatchObject({ foods: 7, recipes: 3, ingredients: 6, steps: 4, tags: 3, meals: 3 });

    const soup = (await pool.request().input("h", household).query(
      "SELECT servings, total_minutes, source_url, source_credit FROM recipe WHERE household_id = @h AND name = 'Lentil Soup'",
    )).recordset[0];
    expect(soup).toEqual({ servings: 4, total_minutes: 75, source_url: "https://www.example-cooking.test/lentil-soup", source_credit: "example-cooking.test" });
    const lentils = (await pool.request().input("h", household).query(`
      SELECT i.quantity, u.abbreviation AS unit, i.note FROM recipe_ingredient i JOIN food f ON f.id = i.food_id LEFT JOIN unit u ON u.id = i.unit_id
      WHERE i.household_id = @h AND f.name = 'Red Lentils'`)).recordset[0];
    expect(lentils).toEqual({ quantity: 1.5, unit: "cup", note: "rinsed" });
    const dinner = (await pool.request().input("h", household).query(
      "SELECT CONVERT(char(10), plan_date, 23) AS d, meal_slot, servings FROM planned_meal WHERE household_id = @h ORDER BY plan_date, meal_slot",
    )).recordset;
    expect(dinner).toEqual([
      { d: "2026-11-23", meal_slot: "breakfast", servings: 1 },
      { d: "2026-11-23", meal_slot: "dinner", servings: 4 },
      { d: "2026-11-24", meal_slot: "dinner", servings: 2 },
    ]);

    const text = formatReport(report);
    expect(text).toMatch(/"broken-recipe"/); // couldn't be read
    expect(text).toMatch(/unit "clove"/); // unknown unit
    expect(text).toMatch(/salt to taste/); // an ingredient line with no food
    expect(text).toMatch(/Takeout night/); // a note, not a recipe
    expect(text).toMatch(/recipe that wasn't imported/); // plan entry on the broken recipe
    expect(text).toMatch(/"side"/);
  });

  it("changes nothing on a second run, and reports the same problems", async () => {
    const before = await counts();
    const first = (await pool.request().query("SELECT COUNT(*) AS n FROM recipe")).recordset[0].n;
    const report = await importMealie(pool, household, await read());
    expect(report.foods).toMatchObject({ created: 0, linked: 0, unchanged: 4 });
    expect(report.recipes).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(report.mealPlans).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(await counts()).toEqual(before);
    expect((await pool.request().query("SELECT COUNT(*) AS n FROM recipe")).recordset[0].n).toBe(first);
    expect(report.problems.length).toBeGreaterThanOrEqual(5);
  });

  it("updates a recipe that changed in Mealie, and leaves one the kitchen app edited alone", async () => {
    await pool.request().input("h", household).query("UPDATE recipe SET servings = 9 WHERE household_id = @h AND name = 'Easy Bread'");
    const fixture = loadFixture();
    const soup = fixture.recipes.find((r) => r.id === "r-soup")!;
    soup.recipeInstructions = [{ text: "Just simmer everything." }];
    const report = await importMealie(pool, household, await read(fixture));
    expect(report.recipes).toEqual({ created: 0, updated: 1, unchanged: 2 });
    const steps = (await pool.request().input("h", household).query(
      "SELECT s.instruction FROM recipe_step s JOIN recipe r ON r.id = s.recipe_id WHERE r.household_id = @h AND r.name = 'Lentil Soup'",
    )).recordset;
    expect(steps).toEqual([{ instruction: "Just simmer everything." }]);
    const bread = (await pool.request().input("h", household).query("SELECT servings FROM recipe WHERE household_id = @h AND name = 'Easy Bread'")).recordset[0];
    expect(bread.servings).toBe(9);
    expect((await counts()).recipes).toBe(3);
  });

  it("recreates a recipe that was deleted in the kitchen app, with its meal plan entry", async () => {
    await pool.request().input("h", household).query("DELETE recipe WHERE household_id = @h AND name = 'Plain Rice'");
    expect((await counts()).meals).toBe(2);
    const report = await importMealie(pool, household, await read());
    expect(report.recipes.created).toBe(1);
    expect(report.mealPlans.created).toBe(1);
    expect(await counts()).toMatchObject({ recipes: 3, meals: 3 });
  });

  it("matches a food the household already had instead of adding a second one", async () => {
    const other = (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Other')")).recordset[0].id;
    await pool.request().input("h", other).query("INSERT food (household_id, name) VALUES (@h, 'FLOUR')");
    const report = await importMealie(pool, other, await read());
    expect(report.foods).toMatchObject({ linked: 1, created: 3 });
    expect((await pool.request().input("h", other).query("SELECT COUNT(*) AS n FROM food WHERE household_id = @h AND name = 'Flour'")).recordset[0].n).toBe(1);
  });
});
