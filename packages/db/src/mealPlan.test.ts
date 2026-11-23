import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MealPlanError, createMealPlan, type MealPlan } from "./mealPlan.js";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("meal plan", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let plan: MealPlan;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    plan = createMealPlan(pool);
  });
  afterAll(async () => {
    await drop();
  });

  async function id(query: string, params: Record<string, unknown> = {}): Promise<string> {
    const request = pool.request();
    for (const [k, v] of Object.entries(params)) request.input(k, v);
    return (await request.query(query)).recordset[0].id;
  }
  const newHousehold = () => id("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')");
  const newRecipe = (h: string, name: string, servings: number | null = null) =>
    id("INSERT recipe (household_id, name, servings) OUTPUT inserted.id VALUES (@h, @name, @servings)", { h, name, servings });
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  // 2026-11-23 is a Monday.
  const MONDAY = "2026-11-23";

  /** A household with a soup (4 servings) and a flatbread (no servings). */
  async function kitchen() {
    const household = await newHousehold();
    const soup = await newRecipe(household, "Lentil soup", 4);
    const bread = await newRecipe(household, "Flatbread");
    return { household, soup, bread };
  }

  it("adds a meal to a day and slot, taking the recipe's servings unless told otherwise", async () => {
    const { household, soup, bread } = await kitchen();

    const dinner = await plan.add(household, { date: "2026-11-24", slot: "dinner", recipeId: soup });
    const lunch = await plan.add(household, { date: "2026-11-24", slot: "lunch", recipeId: bread });
    const big = await plan.add(household, { date: "2026-11-25", slot: "dinner", recipeId: soup, servings: 8 });

    expect(dinner).toMatchObject({ date: "2026-11-24", slot: "dinner", recipeId: soup, recipeName: "Lentil soup", servings: 4 });
    expect(lunch.servings).toBe(1);
    expect(big.servings).toBe(8);
  });

  it("lists a week in date then breakfast-to-snack order, leaving out other weeks and other households", async () => {
    const { household, soup, bread } = await kitchen();
    const other = await kitchen();
    await plan.add(household, { date: "2026-11-24", slot: "dinner", recipeId: soup });
    await plan.add(household, { date: "2026-11-24", slot: "breakfast", recipeId: bread });
    await plan.add(household, { date: MONDAY, slot: "snack", recipeId: bread });
    await plan.add(household, { date: "2026-11-29", slot: "dinner", recipeId: soup }); // last day of the week
    await plan.add(household, { date: "2026-11-22", slot: "dinner", recipeId: soup }); // the day before
    await plan.add(household, { date: "2026-11-30", slot: "dinner", recipeId: soup }); // the day after
    await plan.add(other.household, { date: MONDAY, slot: "dinner", recipeId: other.soup });

    const week = await plan.listWeek(household, MONDAY);

    expect(week.map((m) => [m.date, m.slot])).toEqual([
      [MONDAY, "snack"],
      ["2026-11-24", "breakfast"],
      ["2026-11-24", "dinner"],
      ["2026-11-29", "dinner"],
    ]);
  });

  it("moves a meal to another day and slot without losing its servings", async () => {
    const { household, soup } = await kitchen();
    const meal = await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup, servings: 6 });

    const moved = await plan.update(household, meal.id, { date: "2026-11-27", slot: "lunch" });

    expect(moved).toMatchObject({ id: meal.id, date: "2026-11-27", slot: "lunch", servings: 6 });
    const week = await plan.listWeek(household, MONDAY);
    expect(week).toEqual([moved]);
  });

  it("changes servings on their own, and may keep the same recipe twice in a slot", async () => {
    const { household, soup } = await kitchen();
    const first = await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup });
    await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup });

    const changed = await plan.update(household, first.id, { servings: 2 });

    expect(changed).toMatchObject({ date: MONDAY, slot: "dinner", servings: 2 });
    expect(await plan.listWeek(household, MONDAY)).toHaveLength(2);
  });

  it("removes a meal and says so when it's already gone", async () => {
    const { household, soup } = await kitchen();
    const meal = await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup });
    const keep = await plan.add(household, { date: "2026-11-24", slot: "dinner", recipeId: soup });

    await plan.remove(household, meal.id);

    expect(await plan.listWeek(household, MONDAY)).toEqual([keep]);
    expect(await rejection(plan.remove(household, meal.id))).toMatchObject({ code: "not-found" });
  });

  it("plans, moves and clears a whole week", async () => {
    const { household, soup, bread } = await kitchen();
    const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
    const added = [];
    for (const date of days) {
      added.push(await plan.add(household, { date, slot: "lunch", recipeId: bread }));
      added.push(await plan.add(household, { date, slot: "dinner", recipeId: soup }));
    }
    expect(await plan.listWeek(household, MONDAY)).toHaveLength(14);

    // Shift every dinner a day later; Sunday's falls into next week.
    for (const meal of added.filter((m) => m.slot === "dinner")) {
      const next = new Date(`${meal.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      await plan.update(household, meal.id, { date: next.toISOString().slice(0, 10) });
    }
    const week = await plan.listWeek(household, MONDAY);
    expect(week.filter((m) => m.slot === "dinner").map((m) => m.date)).toEqual(days.slice(1));
    expect((await plan.listWeek(household, "2026-11-30")).map((m) => m.date)).toEqual(["2026-11-30"]);

    for (const meal of added) await plan.remove(household, meal.id);
    expect(await plan.listWeek(household, MONDAY)).toEqual([]);
  });

  it("refuses another household's recipe and meal", async () => {
    const mine = await kitchen();
    const theirs = await kitchen();
    const theirMeal = await plan.add(theirs.household, { date: MONDAY, slot: "dinner", recipeId: theirs.soup });

    expect(await rejection(plan.add(mine.household, { date: MONDAY, slot: "dinner", recipeId: theirs.soup }))).toMatchObject({ code: "not-found" });
    expect(await rejection(plan.update(mine.household, theirMeal.id, { servings: 3 }))).toMatchObject({ code: "not-found" });
    expect(await rejection(plan.remove(mine.household, theirMeal.id))).toMatchObject({ code: "not-found" });
    expect((await plan.listWeek(theirs.household, MONDAY))[0]?.servings).toBe(4);
  });

  it("drops a recipe's planned meals when the recipe is deleted", async () => {
    const { household, soup, bread } = await kitchen();
    await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup });
    await plan.add(household, { date: MONDAY, slot: "lunch", recipeId: bread });

    await pool.request().input("r", soup).query("DELETE recipe WHERE id = @r");

    expect((await plan.listWeek(household, MONDAY)).map((m) => m.recipeName)).toEqual(["Flatbread"]);
  });

  it.each([
    ["a slot that doesn't exist", { date: MONDAY, slot: "brunch" }],
    ["a date that doesn't exist", { date: "2026-02-30", slot: "dinner" }],
    ["a date in the wrong format", { date: "23/11/2026", slot: "dinner" }],
    ["zero servings", { date: MONDAY, slot: "dinner", servings: 0 }],
    ["fractional servings", { date: MONDAY, slot: "dinner", servings: 1.5 }],
    ["too many servings", { date: MONDAY, slot: "dinner", servings: 1001 }],
  ])("refuses %s", async (_what, bad) => {
    const { household, soup } = await kitchen();

    const error = await rejection(plan.add(household, { recipeId: soup, ...bad } as Parameters<MealPlan["add"]>[1]));

    expect(error).toBeInstanceOf(MealPlanError);
    expect(error).toMatchObject({ code: "invalid" });
  });

  it("refuses an empty or invalid change, and a week starting on a bad date", async () => {
    const { household, soup } = await kitchen();
    const meal = await plan.add(household, { date: MONDAY, slot: "dinner", recipeId: soup });

    expect(await rejection(plan.update(household, meal.id, {}))).toMatchObject({ code: "invalid" });
    expect(await rejection(plan.update(household, meal.id, { servings: 0 }))).toMatchObject({ code: "invalid" });
    expect(await rejection(plan.update(household, meal.id, { slot: "brunch" as "dinner" }))).toMatchObject({ code: "invalid" });
    expect(await rejection(plan.listWeek(household, "next week"))).toMatchObject({ code: "invalid" });
  });
});
