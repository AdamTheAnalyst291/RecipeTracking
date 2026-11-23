import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { PantryError, createPantry, type Pantry } from "./pantry.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("pantry", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let pantry: Pantry;
  let gram: string;
  let each: string;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    pantry = createPantry(pool);
    const units = await pool.request().query("SELECT id, abbreviation FROM unit");
    const id = (abbr: string): string => units.recordset.find((u) => u.abbreviation === abbr).id;
    gram = id("g");
    each = id("ea");
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
  /** A household with a flour product (500 g) ready to use. */
  async function withFlour(options: { staple?: boolean; stockQuantity?: number } = {}) {
    const household = await newHousehold();
    const food = await newFood(household, "Flour");
    const product = await pantry.addProduct(household, { foodId: food, unitId: gram, ...options });
    return { household, food, product };
  }
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  describe("products", () => {
    it("links a product to a food and starts with no stock, not a staple and no price", async () => {
      const { household, food, product } = await withFlour();

      expect(product).toMatchObject({
        foodId: food,
        name: "Flour",
        unit: "g",
        stockQuantity: 0,
        staple: false,
        packageQuantity: null,
        priceCents: null,
        priceDate: null,
      });
      expect(await pantry.listProducts(household)).toEqual([product]);
    });

    it("can be named differently from its food, for a brand", async () => {
      const household = await newHousehold();
      const food = await newFood(household, "Flour");
      const product = await pantry.addProduct(household, { foodId: food, unitId: gram, name: "Mill & Co plain flour" });

      expect(product.name).toBe("Mill & Co plain flour");
    });

    it("refuses a food that belongs to another household", async () => {
      const mine = await newHousehold();
      const theirs = await newHousehold();
      const theirFood = await newFood(theirs, "Flour");

      expect(await rejection(pantry.addProduct(mine, { foodId: theirFood, unitId: gram }))).toMatchObject({
        code: "not-found",
      });
    });

    it("refuses a unit that does not exist", async () => {
      const household = await newHousehold();
      const food = await newFood(household, "Flour");

      expect(
        await rejection(pantry.addProduct(household, { foodId: food, unitId: "00000000-0000-4000-8000-000000000000" })),
      ).toMatchObject({ code: "not-found" });
    });

    it("lists only the household's own products", async () => {
      const a = await withFlour();
      const b = await withFlour();

      expect((await pantry.listProducts(a.household)).map((p) => p.id)).toEqual([a.product.id]);
      expect((await pantry.listProducts(b.household)).map((p) => p.id)).toEqual([b.product.id]);
    });
  });

  describe("stock", () => {
    it("starts from the quantity given when the product is added", async () => {
      const { product } = await withFlour({ stockQuantity: 750 });

      expect(product.stockQuantity).toBe(750);
    });

    it("sets stock to an exact quantity", async () => {
      const { household, product } = await withFlour({ stockQuantity: 750 });

      const updated = await pantry.adjustStock(household, product.id, { set: 1200.5 });

      expect(updated.stockQuantity).toBe(1200.5);
      expect((await pantry.listProducts(household))[0]?.stockQuantity).toBe(1200.5);
    });

    it("adds and takes away from stock by a change", async () => {
      const { household, product } = await withFlour({ stockQuantity: 500 });

      await pantry.adjustStock(household, product.id, { delta: 1000 });
      const updated = await pantry.adjustStock(household, product.id, { delta: -300 });

      expect(updated.stockQuantity).toBe(1200);
    });

    it("lets stock reach zero but not go below it", async () => {
      const { household, product } = await withFlour({ stockQuantity: 100 });

      expect((await pantry.adjustStock(household, product.id, { delta: -100 })).stockQuantity).toBe(0);
      expect(await rejection(pantry.adjustStock(household, product.id, { delta: -1 }))).toMatchObject({ code: "invalid" });
      expect(await rejection(pantry.adjustStock(household, product.id, { set: -5 }))).toMatchObject({ code: "invalid" });
      expect((await pantry.listProducts(household))[0]?.stockQuantity).toBe(0);
    });

    it("applies two changes made at the same time without losing one", async () => {
      const { household, product } = await withFlour({ stockQuantity: 0 });

      await Promise.all(Array.from({ length: 10 }, () => pantry.adjustStock(household, product.id, { delta: 10 })));

      expect((await pantry.listProducts(household))[0]?.stockQuantity).toBe(100);
    });

    it("does not touch another household's product", async () => {
      const mine = await withFlour();
      const theirs = await withFlour({ stockQuantity: 5 });

      expect(await rejection(pantry.adjustStock(mine.household, theirs.product.id, { set: 99 }))).toMatchObject({
        code: "not-found",
      });
      expect((await pantry.listProducts(theirs.household))[0]?.stockQuantity).toBe(5);
    });

    it("rejects a change that is not a number", async () => {
      const { household, product } = await withFlour();

      expect(await rejection(pantry.adjustStock(household, product.id, { delta: Number.NaN }))).toMatchObject({
        code: "invalid",
      });
    });
  });

  describe("staples", () => {
    it("marks a product as a staple and back", async () => {
      const { household, product } = await withFlour();

      expect((await pantry.setStaple(household, product.id, true)).staple).toBe(true);
      expect((await pantry.setStaple(household, product.id, false)).staple).toBe(false);
    });

    it("assumes we need a food nobody tracks", async () => {
      const household = await newHousehold();
      const saffron = await newFood(household, "Saffron");

      expect(await pantry.needsBuying(household, [saffron])).toEqual([saffron]);
    });

    it("assumes we need a food whose product is not marked as a staple, even with stock", async () => {
      const { household, food } = await withFlour({ staple: false, stockQuantity: 5000 });

      expect(await pantry.needsBuying(household, [food])).toEqual([food]);
    });

    it("does not need a staple that is in stock, and needs one that has run out", async () => {
      const { household, food, product } = await withFlour({ staple: true, stockQuantity: 500 });

      expect(await pantry.needsBuying(household, [food])).toEqual([]);

      await pantry.adjustStock(household, product.id, { set: 0 });
      expect(await pantry.needsBuying(household, [food])).toEqual([food]);
    });

    it("counts a food as in stock if any of its staple products is", async () => {
      const { household, food, product } = await withFlour({ staple: true, stockQuantity: 0 });
      await pantry.addProduct(household, { foodId: food, unitId: gram, name: "Spare flour", staple: true, stockQuantity: 200 });

      expect(await pantry.needsBuying(household, [food])).toEqual([]);

      await pantry.adjustStock(household, product.id, { set: 10 });
      expect(await pantry.needsBuying(household, [food])).toEqual([]);
    });

    it("ignores another household's staple of a food with the same name", async () => {
      const mine = await newHousehold();
      const myFlour = await newFood(mine, "Flour");
      await withFlour({ staple: true, stockQuantity: 500 });

      expect(await pantry.needsBuying(mine, [myFlour])).toEqual([myFlour]);
    });
  });

  describe("prices", () => {
    it("records the latest price for a package size, with its date", async () => {
      const { household, product } = await withFlour();

      const updated = await pantry.setPrice(household, product.id, {
        priceCents: 249,
        packageQuantity: 1500,
        date: "2026-11-20",
      });

      expect(updated).toMatchObject({ priceCents: 249, packageQuantity: 1500, priceDate: "2026-11-20" });
    });

    it("replaces the earlier price when the price changes", async () => {
      const { household, product } = await withFlour();
      await pantry.setPrice(household, product.id, { priceCents: 249, packageQuantity: 1500, date: "2026-11-20" });

      const updated = await pantry.setPrice(household, product.id, {
        priceCents: 279,
        packageQuantity: 1500,
        date: "2026-11-22",
      });

      expect(updated).toMatchObject({ priceCents: 279, priceDate: "2026-11-22" });
    });

    it("keeps the newer price when an older-dated one arrives later", async () => {
      const { household, product } = await withFlour();
      await pantry.setPrice(household, product.id, { priceCents: 279, packageQuantity: 1500, date: "2026-11-22" });

      const updated = await pantry.setPrice(household, product.id, { priceCents: 199, packageQuantity: 1500, date: "2026-11-01" });

      expect(updated).toMatchObject({ priceCents: 279, priceDate: "2026-11-22" });
    });

    it("takes a price dated the same day as the one on record", async () => {
      const { household, product } = await withFlour();
      await pantry.setPrice(household, product.id, { priceCents: 279, packageQuantity: 1500, date: "2026-11-22" });

      const updated = await pantry.setPrice(household, product.id, { priceCents: 259, packageQuantity: 1500, date: "2026-11-22" });

      expect(updated.priceCents).toBe(259);
    });

    it.each([
      ["a negative price", { priceCents: -1, packageQuantity: 1500, date: "2026-11-20" }],
      ["a fractional number of cents", { priceCents: 2.5, packageQuantity: 1500, date: "2026-11-20" }],
      ["a package of nothing", { priceCents: 249, packageQuantity: 0, date: "2026-11-20" }],
      ["a date that is not a date", { priceCents: 249, packageQuantity: 1500, date: "yesterday" }],
      ["a date that does not exist", { priceCents: 249, packageQuantity: 1500, date: "2026-02-31" }],
    ])("rejects %s", async (_name, price) => {
      const { household, product } = await withFlour();

      expect(await rejection(pantry.setPrice(household, product.id, price))).toMatchObject({ code: "invalid" });
      expect((await pantry.listProducts(household))[0]?.priceCents).toBeNull();
    });

    it("does not touch another household's product", async () => {
      const mine = await withFlour();
      const theirs = await withFlour();

      expect(
        await rejection(
          pantry.setPrice(mine.household, theirs.product.id, { priceCents: 1, packageQuantity: 1, date: "2026-11-20" }),
        ),
      ).toMatchObject({ code: "not-found" });
    });
  });

  describe("daily snapshots", () => {
    async function snapshotRows(productId: string) {
      const r = await pool
        .request()
        .input("p", productId)
        .query(
          `SELECT CONVERT(CHAR(10), snapshot_date, 23) AS day, stock_quantity, unit_id, package_quantity, price_cents,
                  CONVERT(CHAR(10), price_date, 23) AS price_date
           FROM pantry_snapshot WHERE product_id = @p ORDER BY snapshot_date`,
        );
      return r.recordset;
    }

    it("writes one row per product holding its stock and price that day", async () => {
      const { household, product } = await withFlour({ stockQuantity: 500 });
      await pantry.setPrice(household, product.id, { priceCents: 249, packageQuantity: 1500, date: "2026-11-20" });

      const written = await pantry.snapshotAll("2026-11-22");

      expect(written).toBeGreaterThanOrEqual(1);
      expect(await snapshotRows(product.id)).toEqual([
        {
          day: "2026-11-22",
          stock_quantity: 500,
          unit_id: gram,
          package_quantity: 1500,
          price_cents: 249,
          price_date: "2026-11-20",
        },
      ]);
    });

    it("snapshots a product with no price yet", async () => {
      const { product } = await withFlour({ stockQuantity: 3 });

      await pantry.snapshotAll("2026-11-22");

      expect(await snapshotRows(product.id)).toMatchObject([{ stock_quantity: 3, price_cents: null, package_quantity: null }]);
    });

    it("overwrites the day's row when it runs again the same day", async () => {
      const { household, product } = await withFlour({ stockQuantity: 500 });
      await pantry.snapshotAll("2026-11-22");

      await pantry.adjustStock(household, product.id, { set: 120 });
      await pantry.setPrice(household, product.id, { priceCents: 300, packageQuantity: 1000, date: "2026-11-22" });
      await pantry.snapshotAll("2026-11-22");

      expect(await snapshotRows(product.id)).toMatchObject([
        { day: "2026-11-22", stock_quantity: 120, price_cents: 300, package_quantity: 1000 },
      ]);
    });

    it("keeps each day as its own row, so a changed value stays on record", async () => {
      const { household, product } = await withFlour({ stockQuantity: 500 });
      await pantry.snapshotAll("2026-11-22");
      await pantry.adjustStock(household, product.id, { set: 100 });
      await pantry.snapshotAll("2026-11-23");

      expect(await snapshotRows(product.id)).toMatchObject([
        { day: "2026-11-22", stock_quantity: 500 },
        { day: "2026-11-23", stock_quantity: 100 },
      ]);
    });

    it("covers every household's products", async () => {
      const a = await withFlour({ stockQuantity: 1 });
      const b = await withFlour({ stockQuantity: 2 });

      await pantry.snapshotAll("2026-11-24");

      expect(await snapshotRows(a.product.id)).toHaveLength(1);
      expect(await snapshotRows(b.product.id)).toHaveLength(1);
    });

    it("refuses a date that is not a date", async () => {
      expect(await rejection(pantry.snapshotAll("2026-13-01"))).toBeInstanceOf(PantryError);
    });
  });

  describe("schema", () => {
    it("refuses a product whose food is in a different household, even by direct insert", async () => {
      const mine = await newHousehold();
      const theirFood = await newFood(await newHousehold(), "Flour");

      await expect(
        pool
          .request()
          .input("h", mine)
          .input("f", theirFood)
          .input("u", each)
          .query("INSERT product (household_id, food_id, name, unit_id) VALUES (@h, @f, 'x', @u)"),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });
  });
});
