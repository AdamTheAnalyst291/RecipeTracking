import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookingError, createCooking, type Cooking } from "./cooking.js";
import { runMigrations } from "./migrate.js";
import { createPantry, type Pantry } from "./pantry.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("cooking a recipe", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let pantry: Pantry;
  let cooking: Cooking;
  const unit: Record<string, string> = {};

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    pantry = createPantry(pool);
    cooking = createCooking(pool);
    const units = await pool.request().query("SELECT id, abbreviation FROM unit");
    for (const u of units.recordset) unit[u.abbreviation] = u.id;
  });
  afterAll(async () => {
    await drop();
  });

  async function newHousehold(): Promise<string> {
    const r = await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')");
    return r.recordset[0].id;
  }
  async function newFood(household: string, name: string): Promise<string> {
    const r = await pool
      .request()
      .input("h", household)
      .input("n", name)
      .query("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @n)");
    return r.recordset[0].id;
  }
  interface Line {
    food: string;
    quantity: number | null;
    unit: string | null;
  }
  /** A made-up recipe whose ingredient foods are created as needed; returns the ids. */
  async function newRecipe(household: string, servings: number | null, lines: Line[]) {
    const recipe = await pool
      .request()
      .input("h", household)
      .input("s", servings)
      .query("INSERT recipe (household_id, name, servings) OUTPUT inserted.id VALUES (@h, 'Test stew', @s)");
    const recipeId = recipe.recordset[0].id as string;
    const foods: Record<string, string> = {};
    for (const [i, line] of lines.entries()) {
      foods[line.food] ??= await newFood(household, line.food);
      await pool
        .request()
        .input("r", recipeId)
        .input("h", household)
        .input("p", i + 1)
        .input("f", foods[line.food])
        .input("q", line.quantity)
        .input("u", line.unit === null ? null : unit[line.unit])
        .query(
          "INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, unit_id) VALUES (@r, @h, @p, @f, @q, @u)",
        );
    }
    return { recipeId, foods };
  }
  async function stockOf(household: string, productId: string): Promise<number> {
    const products = await pantry.listProducts(household);
    return products.find((p) => p.id === productId)!.stockQuantity;
  }
  async function events(household: string) {
    const r = await pool
      .request()
      .input("h", household)
      .query("SELECT recipe_id, recipe_name, servings_made FROM cooked_event WHERE household_id = @h");
    return r.recordset;
  }
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  it("takes the scaled, unit-converted amounts out of stock", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 4, [
      { food: "Flour", quantity: 500, unit: "g" },
      { food: "Milk", quantity: 2, unit: "cup" },
    ]);
    const flour = await pantry.addProduct(h, { foodId: foods.Flour!, unitId: unit.kg!, stockQuantity: 2 });
    const milk = await pantry.addProduct(h, { foodId: foods.Milk!, unitId: unit.ml!, stockQuantity: 1000 });

    // Half the recipe: 250 g = 0.25 kg of flour, 1 cup = 236.5882 ml of milk.
    const result = await cooking.cook(h, recipeId, { servingsMade: 2 });

    expect(await stockOf(h, flour.id)).toBeCloseTo(1.75, 4);
    expect(await stockOf(h, milk.id)).toBeCloseTo(1000 - 236.5882, 3);
    expect(result.servingsMade).toBe(2);
    expect(result.used.map((u) => u.product).sort()).toEqual(["Flour", "Milk"]);
    expect(result.shortfalls).toEqual([]);
  });

  it("makes the whole recipe when no servings are given", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 4, [{ food: "Rice", quantity: 300, unit: "g" }]);
    const rice = await pantry.addProduct(h, { foodId: foods.Rice!, unitId: unit.g!, stockQuantity: 1000 });
    const result = await cooking.cook(h, recipeId);
    expect(await stockOf(h, rice.id)).toBe(700);
    expect(result.servingsMade).toBe(4);
  });

  it("ignores foods with no pantry product, lines with no amount and units that can't be converted", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 2, [
      { food: "Salt", quantity: 5, unit: "g" }, // untracked: no product
      { food: "Pepper", quantity: null, unit: null }, // "to taste"
      { food: "Eggs", quantity: 3, unit: "ea" },
      { food: "Oil", quantity: 2, unit: "cup" }, // product counted in grams: no conversion
    ]);
    const pepper = await pantry.addProduct(h, { foodId: foods.Pepper!, unitId: unit.g!, stockQuantity: 50 });
    const eggs = await pantry.addProduct(h, { foodId: foods.Eggs!, unitId: unit.ea!, stockQuantity: 12 });
    const oil = await pantry.addProduct(h, { foodId: foods.Oil!, unitId: unit.g!, stockQuantity: 400 });

    const result = await cooking.cook(h, recipeId);

    expect(await stockOf(h, pepper.id)).toBe(50);
    expect(await stockOf(h, oil.id)).toBe(400);
    expect(await stockOf(h, eggs.id)).toBe(9);
    expect(result.used.map((u) => u.product)).toEqual(["Eggs"]);
    expect(await events(h)).toHaveLength(1);
  });

  it("never lets stock go below zero, and says what ran short", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 2, [{ food: "Flour", quantity: 500, unit: "g" }]);
    const flour = await pantry.addProduct(h, { foodId: foods.Flour!, unitId: unit.g!, stockQuantity: 120 });

    const result = await cooking.cook(h, recipeId);

    expect(await stockOf(h, flour.id)).toBe(0);
    expect(result.used).toEqual([expect.objectContaining({ product: "Flour", amount: 120, unit: "g" })]);
    expect(result.shortfalls).toEqual([{ food: "Flour", amount: 380, unit: "g" }]);
    expect(await events(h)).toHaveLength(1);
  });

  it("spreads one food over several products and handles a food listed twice", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 1, [
      { food: "Flour", quantity: 300, unit: "g" },
      { food: "Flour", quantity: 100, unit: "g" },
    ]);
    const a = await pantry.addProduct(h, { foodId: foods.Flour!, unitId: unit.g!, name: "Flour A", stockQuantity: 150 });
    const b = await pantry.addProduct(h, { foodId: foods.Flour!, unitId: unit.g!, name: "Flour B", stockQuantity: 500 });

    await cooking.cook(h, recipeId);

    expect((await stockOf(h, a.id)) + (await stockOf(h, b.id))).toBe(250);
    expect(await stockOf(h, a.id)).toBeGreaterThanOrEqual(0);
  });

  it("saves a cooked event with the recipe, servings and time", async () => {
    const h = await newHousehold();
    const { recipeId } = await newRecipe(h, 4, []);
    const result = await cooking.cook(h, recipeId, { servingsMade: 6 });
    const rows = await events(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipe_name: "Test stew" });
    expect(String(rows[0].recipe_id).toLowerCase()).toBe(recipeId.toLowerCase());
    expect(Number(rows[0].servings_made)).toBe(6);
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(result.cookedAt))).toBe(false);
  });

  it("changes nothing when it fails part-way", async () => {
    const h = await newHousehold();
    const { recipeId, foods } = await newRecipe(h, 2, [{ food: "Flour", quantity: 500, unit: "g" }]);
    const flour = await pantry.addProduct(h, { foodId: foods.Flour!, unitId: unit.g!, stockQuantity: 1000 });
    // The event is written after the stock is taken, so a failure there must undo the stock.
    await pool
      .request()
      .batch("CREATE TRIGGER trg_fail_cooked ON cooked_event AFTER INSERT AS BEGIN THROW 51000, 'boom', 1; END");
    try {
      expect(await rejection(cooking.cook(h, recipeId))).toBeInstanceOf(Error);
    } finally {
      await pool.request().batch("DROP TRIGGER trg_fail_cooked");
    }
    expect(await stockOf(h, flour.id)).toBe(1000);
    expect(await events(h)).toHaveLength(0);
  });

  it("refuses a recipe from another household and leaves its stock alone", async () => {
    const mine = await newHousehold();
    const theirs = await newHousehold();
    const { recipeId, foods } = await newRecipe(theirs, 2, [{ food: "Flour", quantity: 100, unit: "g" }]);
    const flour = await pantry.addProduct(theirs, { foodId: foods.Flour!, unitId: unit.g!, stockQuantity: 100 });

    const error = await rejection(cooking.cook(mine, recipeId));

    expect(error).toBeInstanceOf(CookingError);
    expect((error as CookingError).code).toBe("not-found");
    expect(await stockOf(theirs, flour.id)).toBe(100);
    expect(await events(theirs)).toHaveLength(0);
  });

  it("refuses servings that aren't a sensible positive number", async () => {
    const h = await newHousehold();
    const { recipeId } = await newRecipe(h, 2, []);
    for (const servingsMade of [0, -1, Number.NaN, 1_000_000]) {
      const error = await rejection(cooking.cook(h, recipeId, { servingsMade }));
      expect((error as CookingError).code).toBe("invalid");
    }
    expect(await events(h)).toHaveLength(0);
  });

  it("keeps the event when the recipe is later deleted", async () => {
    const h = await newHousehold();
    const { recipeId } = await newRecipe(h, 2, []);
    await cooking.cook(h, recipeId);
    await pool.request().input("r", recipeId).query("DELETE recipe WHERE id = @r");
    const rows = await events(h);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipe_id).toBeNull();
    expect(rows[0].recipe_name).toBe("Test stew");
  });
});
