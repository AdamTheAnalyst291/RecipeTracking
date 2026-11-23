import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("recipe model", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
  });
  afterAll(async () => {
    await drop();
  });

  async function id(query: string, params: Record<string, unknown> = {}): Promise<string> {
    const request = pool.request();
    for (const [k, v] of Object.entries(params)) request.input(k, v);
    return (await request.query(query)).recordset[0].id;
  }
  const newHousehold = (name = "Test household") =>
    id("INSERT household (name) OUTPUT inserted.id VALUES (@name)", { name });
  const newFood = (h: string, name: string) =>
    id("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @name)", { h, name });
  const newRecipe = (h: string, name = "Test soup") =>
    id("INSERT recipe (household_id, name) OUTPUT inserted.id VALUES (@h, @name)", { h, name });

  it("keeps a recipe with its tags, ingredients and ordered steps", async () => {
    const h = await newHousehold();
    const r = await newRecipe(h);
    const food = await newFood(h, "Lentils");
    await pool.request().input("r", r).input("h", h).input("f", food).query(`
      INSERT recipe_tag (recipe_id, tag) VALUES (@r, 'soup');
      INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, note) VALUES (@r, @h, 1, @f, 1.5, 'rinsed');
      INSERT recipe_step (recipe_id, position, instruction) VALUES (@r, 1, 'Simmer.'), (@r, 2, 'Serve.');`);
    const steps = await pool.request().input("r", r).query("SELECT instruction FROM recipe_step WHERE recipe_id = @r ORDER BY position");
    expect(steps.recordset.map((s) => s.instruction)).toEqual(["Simmer.", "Serve."]);
  });

  it("deletes a recipe's tags, ingredients and steps with it, and leaves the food", async () => {
    const h = await newHousehold();
    const r = await newRecipe(h);
    const food = await newFood(h, "Rice");
    await pool.request().input("r", r).input("h", h).input("f", food).query(`
      INSERT recipe_tag (recipe_id, tag) VALUES (@r, 'side');
      INSERT recipe_ingredient (recipe_id, household_id, position, food_id) VALUES (@r, @h, 1, @f);
      INSERT recipe_step (recipe_id, position, instruction) VALUES (@r, 1, 'Boil.');`);
    await pool.request().input("r", r).query("DELETE recipe WHERE id = @r");
    const left = await pool.request().input("r", r).input("f", food).query(`
      SELECT (SELECT COUNT(*) FROM recipe_tag WHERE recipe_id = @r) AS tags,
             (SELECT COUNT(*) FROM recipe_ingredient WHERE recipe_id = @r) AS ingredients,
             (SELECT COUNT(*) FROM recipe_step WHERE recipe_id = @r) AS steps,
             (SELECT COUNT(*) FROM food WHERE id = @f) AS food`);
    expect(left.recordset[0]).toEqual({ tags: 0, ingredients: 0, steps: 0, food: 1 });
  });

  it("refuses an ingredient whose food belongs to another household", async () => {
    const a = await newHousehold("A");
    const b = await newHousehold("B");
    const r = await newRecipe(a);
    const foreignFood = await newFood(b, "Salt");
    await expect(
      pool.request().input("r", r).input("h", a).input("f", foreignFood).query(
        "INSERT recipe_ingredient (recipe_id, household_id, position, food_id) VALUES (@r, @h, 1, @f)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("refuses an ingredient filed under another household than its recipe's", async () => {
    const a = await newHousehold("A");
    const b = await newHousehold("B");
    const r = await newRecipe(a);
    const food = await newFood(b, "Pepper");
    await expect(
      pool.request().input("r", r).input("h", b).input("f", food).query(
        "INSERT recipe_ingredient (recipe_id, household_id, position, food_id) VALUES (@r, @h, 1, @f)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("refuses a recipe in a household that does not exist, and a blank name", async () => {
    await expect(newRecipe("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/FOREIGN KEY/i);
    await expect(newRecipe(await newHousehold(), "   ")).rejects.toThrow(/CHECK/i);
  });

  it("refuses two steps or two ingredients in the same place, and a tag twice", async () => {
    const h = await newHousehold();
    const r = await newRecipe(h);
    const food = await newFood(h, "Oil");
    const run = (q: string) => pool.request().input("r", r).input("h", h).input("f", food).query(q);
    await run("INSERT recipe_step (recipe_id, position, instruction) VALUES (@r, 1, 'One.')");
    await expect(run("INSERT recipe_step (recipe_id, position, instruction) VALUES (@r, 1, 'Again.')")).rejects.toThrow(/PRIMARY KEY|duplicate/i);
    await run("INSERT recipe_ingredient (recipe_id, household_id, position, food_id) VALUES (@r, @h, 1, @f)");
    await expect(
      run("INSERT recipe_ingredient (recipe_id, household_id, position, food_id) VALUES (@r, @h, 1, @f)"),
    ).rejects.toThrow(/UNIQUE|duplicate/i);
    await run("INSERT recipe_tag (recipe_id, tag) VALUES (@r, 'Quick')");
    await expect(run("INSERT recipe_tag (recipe_id, tag) VALUES (@r, 'quick')")).rejects.toThrow(/PRIMARY KEY|duplicate/i);
  });

  it("refuses servings below one and negative times", async () => {
    const h = await newHousehold();
    const insert = (servings: number | null, minutes: number | null) =>
      pool.request().input("h", h).input("s", servings).input("m", minutes).query(
        "INSERT recipe (household_id, name, servings, total_minutes) VALUES (@h, 'X', @s, @m)",
      );
    await insert(4, 30);
    await insert(null, null);
    await expect(insert(0, 30)).rejects.toThrow(/CHECK/i);
    await expect(insert(4, -1)).rejects.toThrow(/CHECK/i);
  });
});
