import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createPantry, type Pantry } from "./pantry.js";
import { ShoppingListError, createShoppingLists, type ShoppingList, type ShoppingLists } from "./shoppingList.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

// A made-up week: Lentil soup (4 servings) and Flatbread (no servings stated).
describe.skipIf(!testServer)("shopping lists", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let pantry: Pantry;
  let lists: ShoppingLists;
  const unit: Record<string, string> = {};

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    pantry = createPantry(pool);
    lists = createShoppingLists(pool);
    for (const u of (await pool.request().query("SELECT id, abbreviation FROM unit")).recordset) unit[u.abbreviation] = u.id;
  });
  afterAll(async () => {
    await drop();
  });

  async function newHousehold(): Promise<string> {
    return (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
  }
  const foodIds = new Map<string, string>();
  async function food(household: string, name: string): Promise<string> {
    const key = `${household}/${name}`;
    if (!foodIds.has(key)) {
      const r = await pool.request().input("h", household).input("n", name).query("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @n)");
      foodIds.set(key, r.recordset[0].id);
    }
    return foodIds.get(key)!;
  }
  interface Line {
    food: string;
    quantity: number | null;
    unit: string | null;
  }
  async function recipe(household: string, name: string, servings: number | null, lines: Line[]): Promise<string> {
    const r = await pool
      .request()
      .input("h", household)
      .input("n", name)
      .input("s", servings)
      .query("INSERT recipe (household_id, name, servings) OUTPUT inserted.id VALUES (@h, @n, @s)");
    const id = r.recordset[0].id as string;
    for (const [i, line] of lines.entries()) {
      await pool
        .request()
        .input("r", id)
        .input("h", household)
        .input("p", i + 1)
        .input("f", await food(household, line.food))
        .input("q", line.quantity)
        .input("u", line.unit === null ? null : unit[line.unit])
        .query("INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, unit_id) VALUES (@r, @h, @p, @f, @q, @u)");
    }
    return id;
  }
  async function plan(household: string, date: string, recipeId: string, servings: number) {
    await pool
      .request()
      .input("h", household)
      .input("d", date)
      .input("r", recipeId)
      .input("s", servings)
      .query("INSERT planned_meal (household_id, plan_date, meal_slot, recipe_id, servings) VALUES (@h, CONVERT(DATE, @d), 'dinner', @r, @s)");
  }
  const summary = (list: ShoppingList) => list.items.map((i) => `${i.name}: ${i.quantity ?? "-"} ${i.unit ?? ""}`.trim()).sort();
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  /** The fixture week: soup on the 23rd (doubled) and the 25th, flatbread on the 24th, a flatbread outside the range. */
  async function fixtureWeek(): Promise<string> {
    const h = await newHousehold();
    const soup = await recipe(h, "Lentil soup", 4, [
      { food: "Lentils", quantity: 400, unit: "g" },
      { food: "Onion", quantity: 2, unit: "ea" },
      { food: "Olive oil", quantity: 1, unit: "tbsp" },
      { food: "Salt", quantity: null, unit: null },
    ]);
    const bread = await recipe(h, "Flatbread", null, [
      { food: "Flour", quantity: 300, unit: "g" },
      { food: "Olive oil", quantity: 3, unit: "tsp" },
      { food: "Onion", quantity: 100, unit: "g" },
    ]);
    await plan(h, "2026-11-23", soup, 8);
    await plan(h, "2026-11-24", bread, 2);
    await plan(h, "2026-11-25", soup, 4);
    await plan(h, "2026-12-30", bread, 2);
    return h;
  }

  it("totals foods across recipes, scaled and converted, and lists unit kinds apart", async () => {
    const h = await fixtureWeek();

    const list = await lists.generate(h, "2026-11-23", "2026-11-29");

    expect(summary(list)).toEqual([
      "Flour: 300 g", // flatbread has no servings: not scaled
      "Lentils: 1200 g", // 400 × 2 + 400
      "Olive oil: 4 tbsp", // 1 × 2 + 1 tbsp + 3 tsp = 4 tbsp
      "Onion: 100 g",
      "Onion: 6 ea", // 2 × 2 + 2, and not mixed with the 100 g
      "Salt: -",
    ]);
    expect(list.start).toBe("2026-11-23");
    expect(list.end).toBe("2026-11-29");
    expect(list.items.every((i) => !i.checked && i.source === "plan")).toBe(true);
  });

  it("leaves off staples in stock, takes partial stock off, and keeps untracked foods", async () => {
    const h = await fixtureWeek();
    const lentils = await pantry.addProduct(h, { foodId: await food(h, "Lentils"), unitId: unit.kg!, stockQuantity: 2, staple: true });
    await pantry.addProduct(h, { foodId: await food(h, "Flour"), unitId: unit.g!, stockQuantity: 100, staple: true });
    // Not flagged as a staple, so not tracked: still on the list.
    await pantry.addProduct(h, { foodId: await food(h, "Onion"), unitId: unit.ea!, stockQuantity: 50 });
    await pantry.addProduct(h, { foodId: await food(h, "Salt"), unitId: unit.g!, stockQuantity: 500, staple: true });

    const list = await lists.generate(h, "2026-11-23", "2026-11-29");

    expect(lentils.stockQuantity).toBe(2);
    expect(summary(list)).toEqual(["Flour: 200 g", "Olive oil: 4 tbsp", "Onion: 100 g", "Onion: 6 ea"]);
  });

  it("only counts meals within the dates and the household's own", async () => {
    const h = await fixtureWeek();
    const other = await newHousehold();
    const stew = await recipe(other, "Stew", 1, [{ food: "Beef", quantity: 1, unit: "kg" }]);
    await plan(other, "2026-11-24", stew, 1);

    expect(summary(await lists.generate(h, "2026-11-24", "2026-11-24"))).toEqual(["Flour: 300 g", "Olive oil: 3 tsp", "Onion: 100 g"]);
    expect(summary(await lists.generate(h, "2026-12-30", "2026-12-30"))).toHaveLength(3);
    expect(await lists.generate(h, "2026-01-01", "2026-01-02")).toMatchObject({ items: [] });
  });

  it("stores the list, keeps old ones, and returns the newest as latest", async () => {
    const h = await fixtureWeek();
    expect(await lists.latest(h)).toBeUndefined();
    const first = await lists.generate(h, "2026-11-23", "2026-11-23");
    const second = await lists.generate(h, "2026-11-24", "2026-11-24");

    const latest = await lists.latest(h);

    expect(latest?.id).toBe(second.id);
    expect(latest?.items).toEqual(second.items);
    const count = await pool.request().input("h", h).query("SELECT COUNT(*) AS n FROM shopping_list WHERE household_id = @h");
    expect(count.recordset[0].n).toBe(2);
    expect(first.id).not.toBe(second.id);
  });

  it("adds items by hand, checks them off and takes them off", async () => {
    const h = await fixtureWeek();
    const list = await lists.generate(h, "2026-11-24", "2026-11-24");

    const milk = await lists.addItem(h, list.id, { name: "  Milk ", quantity: 2, unitId: unit.l! });
    const foil = await lists.addItem(h, list.id, { name: "Foil" });
    expect(milk).toMatchObject({ name: "Milk", quantity: 2, unit: "l", source: "manual", checked: false });
    expect(foil).toMatchObject({ quantity: null, unit: null, foodId: null });

    expect((await lists.setChecked(h, list.id, milk.id, true)).checked).toBe(true);
    const afterCheck = (await lists.latest(h))!;
    expect(afterCheck.items.find((i) => i.id === milk.id)?.checked).toBe(true);
    // Checked items sink to the bottom.
    expect(afterCheck.items.at(-1)?.id).toBe(milk.id);
    expect((await lists.setChecked(h, list.id, milk.id, false)).checked).toBe(false);

    await lists.removeItem(h, list.id, foil.id);
    expect((await lists.latest(h))!.items.some((i) => i.id === foil.id)).toBe(false);
  });

  it("carries unchecked hand-added items to the next list but not checked ones or plan items", async () => {
    const h = await fixtureWeek();
    const first = await lists.generate(h, "2026-11-24", "2026-11-24");
    const keep = await lists.addItem(h, first.id, { name: "Foil" });
    const bought = await lists.addItem(h, first.id, { name: "Milk", quantity: 1, unitId: unit.l! });
    await lists.setChecked(h, first.id, bought.id, true);

    const next = await lists.generate(h, "2026-11-25", "2026-11-25");

    expect(next.items.filter((i) => i.source === "manual").map((i) => i.name)).toEqual(["Foil"]);
    expect(next.items.find((i) => i.name === "Foil")?.id).not.toBe(keep.id);
    expect(next.items.some((i) => i.name === "Flour")).toBe(false); // the old plan items didn't come along
  });

  it("refuses dates, amounts and units it can't use", async () => {
    const h = await fixtureWeek();
    const list = await lists.generate(h, "2026-11-24", "2026-11-24");

    for (const [start, end] of [["nope", "2026-11-24"], ["2026-11-25", "2026-11-24"], ["2026-01-01", "2027-01-01"]] as const) {
      expect(((await rejection(lists.generate(h, start, end))) as ShoppingListError).code).toBe("invalid");
    }
    for (const item of [{ name: " " }, { name: "x", quantity: 0 }, { name: "x", unitId: unit.g! }, { name: "x", quantity: Number.NaN }]) {
      expect(((await rejection(lists.addItem(h, list.id, item))) as ShoppingListError).code).toBe("invalid");
    }
    const noUnit = await rejection(lists.addItem(h, list.id, { name: "x", quantity: 1, unitId: "00000000-0000-4000-8000-000000000000" }));
    expect((noUnit as ShoppingListError).code).toBe("not-found");
  });

  it("won't touch another household's list or items", async () => {
    const mine = await fixtureWeek();
    const theirs = await fixtureWeek();
    const list = await lists.generate(theirs, "2026-11-24", "2026-11-24");
    const item = list.items[0]!;

    for (const attempt of [
      () => lists.addItem(mine, list.id, { name: "Sneaky" }),
      () => lists.setChecked(mine, list.id, item.id, true),
      () => lists.removeItem(mine, list.id, item.id),
    ]) {
      expect(((await rejection(attempt())) as ShoppingListError).code).toBe("not-found");
    }
    expect(await lists.latest(mine)).toBeUndefined();
    expect((await lists.latest(theirs))!.items.find((i) => i.id === item.id)?.checked).toBe(false);
  });

  it("takes a list's items with it when the list is deleted", async () => {
    const h = await fixtureWeek();
    const list = await lists.generate(h, "2026-11-24", "2026-11-24");
    await pool.request().input("l", list.id).query("DELETE shopping_list WHERE id = @l");
    const left = await pool.request().input("l", list.id).query("SELECT COUNT(*) AS n FROM shopping_list_item WHERE list_id = @l");
    expect(left.recordset[0].n).toBe(0);
  });
});
