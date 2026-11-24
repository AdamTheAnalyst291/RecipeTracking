import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { createPantry } from "../pantry.js";
import { createEmptyDatabase, testServer } from "../test-database.js";
import { createGrocyClient, readGrocy } from "./client.js";
import { fakeGrocy, loadGrocyFixture, type GrocyFixture } from "./fake-grocy.js";
import { formatReport, importGrocy } from "./import.js";

describe.skipIf(!testServer)("import from Grocy", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let household: string;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    household = (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
    // A food that already exists, in different case: the Grocy product should match it.
    await pool.request().input("h", household).query("INSERT food (household_id, name) VALUES (@h, 'whole milk')");
  });
  afterAll(async () => {
    await drop();
  });

  const read = async (fixture: GrocyFixture = loadGrocyFixture()) =>
    readGrocy(createGrocyClient({ baseUrl: "http://grocy.test", apiKey: "k", fetch: fakeGrocy({ fixture }).fetch }));

  async function counts() {
    const r = await pool.request().input("h", household).query(`
      SELECT (SELECT COUNT(*) FROM food WHERE household_id = @h) AS foods,
             (SELECT COUNT(*) FROM product WHERE household_id = @h) AS products,
             (SELECT COUNT(*) FROM import_source WHERE household_id = @h AND source = 'grocy') AS links`);
    return r.recordset[0];
  }
  const products = async () => createPantry(pool).listProducts(household);
  const byName = async (name: string) => {
    const found = (await products()).find((p) => p.name === name);
    if (!found) throw new Error(`no product ${name}`);
    return found;
  };

  it("imports every product with its stock, staple flag and latest price, and reports what it couldn't map", async () => {
    const report = await importGrocy(pool, household, await read());

    expect(report.products).toEqual({ created: 5, updated: 0, unchanged: 0 });
    expect(report.foods).toEqual({ created: 4, linked: 1 });
    expect(await counts()).toEqual({ foods: 5, products: 5, links: 5 });

    expect(await byName("Rice")).toMatchObject({ unit: "g", stockQuantity: 1500, staple: true, priceCents: 399, packageQuantity: 1000, priceDate: "2026-11-02" });
    expect(await byName("Whole Milk")).toMatchObject({ unit: "l", stockQuantity: 2, staple: true, priceCents: 150, packageQuantity: 1, priceDate: "2026-11-20" });
    expect(await byName("Canned Tomatoes")).toMatchObject({ unit: "ea", stockQuantity: 6, staple: true, priceCents: 125, priceDate: "2026-10-30" });
    expect(await byName("Smoked Paprika")).toMatchObject({ unit: "ea", stockQuantity: 1, staple: false, priceCents: null, packageQuantity: null, priceDate: null });
    // No stock row in Grocy means none in the pantry.
    expect(await byName("Olive Oil")).toMatchObject({ unit: "ml", stockQuantity: 0, staple: false, priceCents: 840, packageQuantity: 750, priceDate: "2026-09-14" });

    // Matched to the food the household already had, not a second one.
    const milk = (await byName("Whole Milk")).foodId;
    const food = await pool.request().input("id", milk).query("SELECT name FROM food WHERE id = @id");
    expect(food.recordset[0].name).toBe("whole milk");

    const text = formatReport(report);
    expect(text).toMatch(/Smoked Paprika.*"Jar"/); // unit not in the unit table
    expect(text).toMatch(/Discontinued Cereal/); // inactive, skipped
    expect(text).toMatch(/Smoked Paprika.*no price/);
  });

  it("changes nothing on a second run", async () => {
    const before = { counts: await counts(), products: await products() };
    const report = await importGrocy(pool, household, await read());
    expect(report.products).toEqual({ created: 0, updated: 0, unchanged: 5 });
    expect(report.foods).toEqual({ created: 0, linked: 0 });
    expect(await counts()).toEqual(before.counts);
    expect(await products()).toEqual(before.products);
  });

  it("brings a product up to date when Grocy's stock or price changed, and recreates one that was deleted", async () => {
    const fixture = loadGrocyFixture();
    fixture.stock[0] = { product_id: 1, amount: 1200 };
    fixture.details["1"] = { last_price: 0.0045, last_purchased: "2026-11-21 10:00:00" };
    const report = await importGrocy(pool, household, await read(fixture));
    expect(report.products).toEqual({ created: 0, updated: 1, unchanged: 4 });
    expect(await byName("Rice")).toMatchObject({ stockQuantity: 1200, priceCents: 450, packageQuantity: 1000, priceDate: "2026-11-21" });

    const tomatoes = await byName("Canned Tomatoes");
    await pool.request().input("p", tomatoes.id).query("DELETE FROM product WHERE id = @p");
    const again = await importGrocy(pool, household, await read(fixture));
    expect(again.products).toEqual({ created: 1, updated: 0, unchanged: 4 });
    expect(await byName("Canned Tomatoes")).toMatchObject({ stockQuantity: 6, staple: true, priceCents: 125 });
    expect((await counts()).products).toBe(5);
  });
});
