/**
 * add_receipt (card P4), called through the MCP layer against a real database with fixture
 * receipts (made up), with the resulting rows checked. Only sign-in stands in for the real thing.
 */
import { createPantry, createReceipts, resolveHousehold, runMigrations } from "@kitchen/db";
import { createEmptyDatabase, testServer } from "@kitchen/db/test-database";
import type sql from "mssql";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withAuth, type SignedInUser } from "../auth.js";
import { ADAM, TENANT_ID, testAuthenticator, token } from "../test/identity.js";
import { call, connect } from "../test/mcpClient.js";
import { createMcpHandlers, MCP_LIMITS, type Kitchen } from "./endpoint.js";

const user: SignedInUser = { objectId: ADAM, name: "Test User", household: { id: "home", memberObjectIds: [ADAM] } };

interface ReceiptFixture {
  store: string;
  date: string;
  totalCents: number;
  items: { name: string; item?: string; priceCents: number; quantity?: number; packageQuantity?: number; unit?: string }[];
}

const fixture = (name: string): ReceiptFixture => JSON.parse(readFileSync(new URL(`../test/receipts/${name}.json`, import.meta.url), "utf8")) as ReceiptFixture;

describe.skipIf(!testServer)("add_receipt", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let household: string;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    household = await resolveHousehold(pool, { objectId: ADAM, displayName: user.name });
  }, 120_000);
  afterAll(async () => {
    await drop();
  });
  beforeEach(async () => {
    // In an order the foreign keys allow.
    for (const table of ["price_ledger", "receipt", "product", "food"]) {
      await pool.request().query(`DELETE ${table}`);
    }
  });

  const rows = async (query: string) => (await pool.request().query(query)).recordset;

  async function signedIn() {
    const member = () => resolveHousehold(pool, { objectId: ADAM, displayName: user.name });
    // Only add_receipt's own access is real here; the other tools have their own tests.
    const unused = async () => Promise.reject(new Error("not in these tests"));
    const kitchen: Kitchen = {
      recipes: unused,
      mealPlan: unused,
      pantry: unused,
      shopping: unused,
      cooking: unused,
      fetchPage: unused,
      receipts: async () => ({ receipts: createReceipts(pool), householdId: await member() }),
    };
    const handlers = createMcpHandlers(kitchen, { tenantId: () => TENANT_ID, now: () => new Date("2026-11-27T15:00:00Z") });
    return connect(withAuth(handlers.mcp, () => testAuthenticator, handlers.challenge), "legacy", `Bearer ${await token()}`);
  }

  /** A food with a product of the same name, as the pantry makes them. */
  async function stocked(name: string, unit: string, { staple = true, price }: { staple?: boolean; price?: { priceCents: number; packageQuantity: number; date: string } } = {}) {
    const [food] = await rows(
      `IF NOT EXISTS (SELECT 1 FROM food WHERE household_id = '${household}' AND name = '${name}')
         INSERT food (household_id, name) VALUES ('${household}', '${name}');
       SELECT id FROM food WHERE household_id = '${household}' AND name = '${name}'`,
    );
    const [unitRow] = await rows(`SELECT id FROM unit WHERE abbreviation = '${unit}'`);
    const pantry = createPantry(pool);
    const product = await pantry.addProduct(household, { foodId: food.id, unitId: unitRow.id, staple });
    return price ? pantry.setPrice(household, product.id, price) : product;
  }

  const ledger = () =>
    rows(
      `SELECT l.line_no, l.name, l.quantity, l.price_cents, l.package_quantity, u.abbreviation AS unit,
              f.name AS food, p.name AS product, r.store, CONVERT(CHAR(10), r.receipt_date, 23) AS date, r.total_cents, r.household_id
       FROM price_ledger l
       JOIN receipt r ON r.id = l.receipt_id
       LEFT JOIN unit u ON u.id = l.unit_id
       LEFT JOIN food f ON f.id = l.food_id
       LEFT JOIN product p ON p.id = l.product_id
       ORDER BY r.created_at, l.line_no`,
    );

  describe("the price ledger", () => {
    it("keeps every line of a receipt, matched or not", async () => {
      await stocked("Red lentils", "g");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(json).toMatchObject({ store: "Corner Market", date: "2026-11-26", totalCents: 1884, linesCents: 1884, lines: 6 });
      const saved = await ledger();
      expect(saved.map((l) => [l.line_no, l.name, l.quantity, l.price_cents, l.package_quantity, l.unit, l.product])).toEqual([
        [1, "CM RED LENTILS 2LB", 2, 398, 2, "lb", "Red lentils"],
        [2, "Whole Milk", 1, 349, 1, "l", null],
        [3, "BANANAS", 1, 136, 2.31, "lb", null],
        [4, "XJ QT 4409", 1, 899, null, null, null],
        [5, "MFR COUPON", 1, -75, null, null, null],
        [6, "SALES TAX", 1, 177, null, null, null],
      ]);
      expect(saved[0]).toMatchObject({ store: "Corner Market", date: "2026-11-26", total_cents: 1884, household_id: household.toUpperCase(), food: "Red lentils" });
    });
  });
  describe("staple prices", () => {
    const prices = () =>
      rows("SELECT name, price_cents, package_quantity, CONVERT(CHAR(10), price_date, 23) AS price_date FROM product ORDER BY name");

    it("takes the receipt's price per package and date, in the product's own unit", async () => {
      await stocked("Red lentils", "g");
      await stocked("Whole milk", "ml", { price: { priceCents: 300, packageQuantity: 1000, date: "2026-11-01" } });
      await stocked("Bananas", "lb");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      // 398 cents for two 2 lb bags: 199 cents for one bag of 907.1847 g.
      expect(await prices()).toEqual([
        { name: "Bananas", price_cents: 136, package_quantity: 2.31, price_date: "2026-11-26" },
        { name: "Red lentils", price_cents: 199, package_quantity: 907.1847, price_date: "2026-11-26" },
        { name: "Whole milk", price_cents: 349, package_quantity: 1000, price_date: "2026-11-26" },
      ]);
      expect(json.pricesUpdated).toEqual([
        { line: 1, product: "Red lentils", priceCents: 199, packageQuantity: 907.1847, unit: "g" },
        { line: 2, product: "Whole milk", priceCents: 349, packageQuantity: 1000, unit: "ml" },
        { line: 3, product: "Bananas", priceCents: 136, packageQuantity: 2.31, unit: "lb" },
      ]);
      expect(json.pricesNotUpdated).toEqual([]);
    });

    it.each([
      ["newer", "2026-11-27"],
      ["of the same day", "2026-11-26"],
    ])("keeps a price already on record that is %s, and still ledgers the line", async (_name, date) => {
      await stocked("Whole milk", "ml", { price: { priceCents: 300, packageQuantity: 1000, date } });
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(await prices()).toEqual([{ name: "Whole milk", price_cents: 300, package_quantity: 1000, price_date: date }]);
      expect(json.pricesNotUpdated).toEqual([{ line: 2, product: "Whole milk", reason: `The price on record is from ${date}, so this receipt isn't newer.` }]);
      expect(await ledger()).toHaveLength(6);
    });

    it("leaves a product that isn't a staple alone", async () => {
      await stocked("Whole milk", "ml", { staple: false });
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(await prices()).toEqual([{ name: "Whole milk", price_cents: null, package_quantity: null, price_date: null }]);
      expect(json.pricesNotUpdated).toEqual([{ line: 2, product: "Whole milk", reason: "Not a staple." }]);
    });

    it.each([
      ["has no package size", {}, "The line has no package size."],
      ["is sized in a different kind of unit", { packageQuantity: 1, unit: "l" }, "The size in l can't be turned into g."],
      ["paid nothing", { packageQuantity: 1, unit: "kg", priceCents: 0 }, "The line has no price paid."],
    ])("doesn't price a staple from a line that %s", async (_name, line, reason) => {
      await stocked("Red lentils", "g");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery"), items: [{ name: "Red lentils", priceCents: 199, ...line }] });

      expect(await prices()).toEqual([{ name: "Red lentils", price_cents: null, package_quantity: null, price_date: null }]);
      expect(json.pricesNotUpdated).toEqual([{ line: 1, product: "Red lentils", reason }]);
    });
  });

  describe("lines that could price the same product, or none", () => {
    const send = async (items: ReceiptFixture["items"]) => call(await signedIn(), "add_receipt", { ...fixture("weekly-grocery"), items });
    const price = () => rows("SELECT price_cents FROM product ORDER BY price_cents");
    const milk = { name: "Whole milk", priceCents: 349, packageQuantity: 1, unit: "l" };

    it("prices a product from the first line that can, and says so for the later ones", async () => {
      await stocked("Whole milk", "ml");

      const { json } = await send([{ name: "Whole milk", priceCents: 10 }, milk, { ...milk, priceCents: 199 }]);

      expect(await price()).toEqual([{ price_cents: 349 }]);
      expect(json.pricesNotUpdated).toEqual([
        { line: 1, product: "Whole milk", reason: "The line has no package size." },
        { line: 3, product: "Whole milk", reason: "An earlier line of this receipt already set its price." },
      ]);
    });

    it.each([
      ["several products", ["ml", "l"], "The food has several products; name one with item."],
      ["no product", [], "The food has no product in the pantry."],
    ])("says why nothing was priced when the food has %s", async (_name, units, reason) => {
      await rows(`INSERT food (household_id, name) VALUES ('${household}', 'Whole milk')`);
      for (const unit of units) {
        const product = await stocked("Whole milk", unit);
        await rows(`UPDATE product SET name = 'Milk, ${unit}' WHERE id = '${product.id}'`);
      }

      const { json } = await send([milk]);

      expect(json.pricesNotUpdated).toEqual([{ line: 1, product: null, reason }]);
    });

    it("never prices a staple at nothing when a few cents are split over many packages", async () => {
      await stocked("Whole milk", "ml");

      const { json } = await send([{ ...milk, priceCents: 1, quantity: 3 }]);

      expect(await price()).toEqual([{ price_cents: null }]);
      expect(json.pricesNotUpdated).toEqual([{ line: 1, product: "Whole milk", reason: "The line has no price paid." }]);
    });

    it("says when a size is too small to count in the product's unit", async () => {
      await stocked("Whole milk", "l");

      const { json } = await send([{ ...milk, packageQuantity: 0.0001, unit: "ml" }]);

      expect(json.pricesNotUpdated).toEqual([{ line: 1, product: "Whole milk", reason: "The size is too small to count in l." }]);
    });

    it("picks neither of two foods whose names differ only in spacing", async () => {
      await rows(`INSERT food (household_id, name) VALUES ('${household}', 'Whole milk'), ('${household}', 'Whole  milk')`);

      const { json } = await send([milk]);

      expect(json.matched).toEqual([]);
      expect(json.unmatched).toHaveLength(1);
    });
  });

  describe("matching", () => {
    it("reports the lines it couldn't match, and says what it matched the rest to", async () => {
      await stocked("Red lentils", "g");
      await stocked("Whole milk", "ml");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(json.matched).toEqual([
        { line: 1, name: "CM RED LENTILS 2LB", food: "Red lentils", product: "Red lentils" },
        { line: 2, name: "Whole Milk", food: "Whole milk", product: "Whole milk" },
      ]);
      expect(json.unmatched).toEqual([
        { line: 3, name: "BANANAS", priceCents: 136 },
        { line: 4, name: "XJ QT 4409", priceCents: 899 },
        { line: 5, name: "MFR COUPON", priceCents: -75 },
        { line: 6, name: "SALES TAX", priceCents: 177 },
      ]);
    });

    it("never guesses from a part of a name, and adds no foods or products", async () => {
      await stocked("Milk", "ml");
      await stocked("Lentils", "g");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(json.matched).toEqual([]);
      expect(json.unmatched).toHaveLength(6);
      expect(await rows("SELECT name FROM food ORDER BY name")).toEqual([{ name: "Lentils" }, { name: "Milk" }]);
      expect(await rows("SELECT price_cents FROM product WHERE price_cents IS NOT NULL")).toEqual([]);
    });

    it("matches the food but picks no product when several could be it", async () => {
      await stocked("Whole milk", "ml");
      await stocked("Whole milk", "l");
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(json.matched).toEqual([{ line: 2, name: "Whole Milk", food: "Whole milk", product: null }]);
      expect(json.pricesUpdated).toEqual([]);
      expect((await ledger())[1]).toMatchObject({ food: "Whole milk", product: null });
    });

    it("doesn't match another household's food", async () => {
      await rows(
        `DECLARE @h TABLE (id UNIQUEIDENTIFIER);
         INSERT household (name) OUTPUT inserted.id INTO @h VALUES ('Strangers');
         INSERT food (household_id, name) SELECT id, 'Bananas' FROM @h;`,
      );
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...fixture("weekly-grocery") });

      expect(json.matched).toEqual([]);
    });
  });

  describe("what it accepts", () => {
    const receipts = () => rows("SELECT store FROM receipt");
    const line = { name: "Eggs", priceCents: 399 };
    const receipt = { store: "Corner Market", date: "2026-11-26", totalCents: 399, items: [line] };

    it("tells Claude to confirm the lines with the person first, and that receipt text is data", async () => {
      const client = await signedIn();

      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "add_receipt");

      expect(tool?.description).toMatch(/confirm/i);
      expect(tool?.description).toMatch(/never instructions/i);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    });

    it.each([
      ["no store", { store: "  " }],
      ["a store name longer than the limit", { store: "x".repeat(101) }],
      ["a date that doesn't exist", { date: "2026-02-30" }],
      ["a date in the future", { date: "2026-11-29" }],
      ["a date before 2000", { date: "1999-12-31" }],
      ["a total below 0", { totalCents: -1 }],
      ["a total that isn't whole cents", { totalCents: 3.99 }],
      ["no lines", { items: [] }],
      ["more lines than the limit", { items: Array.from({ length: MCP_LIMITS.receiptLines + 1 }, () => line) }],
      ["a line with no name", { items: [line, { ...line, name: " " }] }],
      ["a line name longer than the limit", { items: [line, { ...line, name: "x".repeat(201) }] }],
      ["a price that isn't whole cents", { items: [{ ...line, priceCents: 3.99 }] }],
      ["an absurd price", { items: [{ ...line, priceCents: 100_000_000 }] }],
      ["a quantity of 0", { items: [{ ...line, quantity: 0 }] }],
      ["a package size without its unit", { items: [{ ...line, packageQuantity: 12 }] }],
      ["a unit without a package size", { items: [{ ...line, unit: "ea" }] }],
      ["a package size too small to store", { items: [{ ...line, packageQuantity: 0.00001, unit: "g" }] }],
    ])("refuses %s and saves nothing", async (_name, wrong) => {
      const client = await signedIn();

      const result = await call(client, "add_receipt", { ...receipt, ...wrong });

      expect(result.isError).toBe(true);
      expect(await receipts()).toEqual([]);
      expect(await ledger()).toEqual([]);
    });

    it("takes a receipt dated tomorrow in UTC, as it may already be that day where it was bought", async () => {
      const client = await signedIn();

      expect((await call(client, "add_receipt", { ...receipt, date: "2026-11-28" })).isError).toBe(false);
    });

    it("refuses an unknown unit, saying which units there are, and saves nothing", async () => {
      const client = await signedIn();

      const result = await call(client, "add_receipt", { ...receipt, items: [{ ...line, packageQuantity: 1, unit: "bunch" }] });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/"bunch" isn't a known unit/);
      expect(result.text).toMatch(/\blb\b/);
      expect(await receipts()).toEqual([]);
    });

    it("doesn't save the same receipt twice", async () => {
      const client = await signedIn();
      await call(client, "add_receipt", receipt);

      const result = await call(client, "add_receipt", { ...receipt, store: " corner   market " });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/already saved/i);
      expect(await receipts()).toHaveLength(1);
      expect(await ledger()).toHaveLength(1);
    });

    it("saves a second purchase that looks the same, when the person says it is one", async () => {
      const client = await signedIn();
      await call(client, "add_receipt", receipt);

      const result = await call(client, "add_receipt", { ...receipt, secondPurchase: true });

      expect(result.isError).toBe(false);
      expect(await receipts()).toHaveLength(2);
    });

    it("saves nothing when the database fails part way, and keeps the cause to the log", async () => {
      await stocked("Eggs", "ea");
      await rows("ALTER TABLE product ADD CONSTRAINT ck_test_fails CHECK (price_cents IS NULL)");
      const client = await signedIn();

      const result = await call(client, "add_receipt", { ...receipt, items: [{ ...line, packageQuantity: 12, unit: "ea" }] });
      await rows("ALTER TABLE product DROP CONSTRAINT ck_test_fails");

      expect(result.isError).toBe(true);
      expect(result.text).not.toMatch(/ck_test_fails/);
      expect(await receipts()).toEqual([]);
      expect(await ledger()).toEqual([]);
    });

    it("strips control characters from the names it hands back", async () => {
      const client = await signedIn();

      const { json } = await call(client, "add_receipt", { ...receipt, store: "Corner\u0007 Market", items: [{ ...line, name: "Eggs‮ now" }] });

      expect(json.store).toBe("Corner Market");
      expect(json.unmatched[0].name).toBe("Eggs now");
    });
  });
});
