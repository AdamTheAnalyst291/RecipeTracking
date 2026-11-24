import { createHash } from "node:crypto";
import mssql from "mssql";
import { matchUnit } from "../mealie/map.js";
import { validatePrice, type Price } from "../pantry.js";
import type { GrocyExport } from "./client.js";

const GUID = mssql.UniqueIdentifier;

export interface Tally {
  created: number;
  /** Already there and changed in Grocy since, so brought up to date. */
  updated: number;
  unchanged: number;
}

export interface GrocyImportReport {
  products: Tally;
  foods: { created: number; linked: number };
  /** Everything that couldn't be carried over exactly, one line each. */
  problems: string[];
}

interface Mapped {
  grocyId: string;
  name: string;
  unit: string;
  unitId: string;
  stock: number;
  staple: boolean;
  price: Price | null;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Writes Grocy's products into one household's pantry: each active product is matched to a
 * food by name (a food is made when there is none) and gets its current stock, a staple flag
 * (Grocy's minimum stock above 0) and the latest price with its date. Running it again is
 * safe: each Grocy product is linked to the product it became (`import_source`), an unchanged
 * one is left alone, a changed one gets its stock, staple flag and price brought up to date,
 * and a deleted one is recreated. Nothing is ever deleted. Problems go in the report, never
 * thrown, so one bad product doesn't stop the rest.
 */
export async function importGrocy(pool: mssql.ConnectionPool, householdId: string, data: GrocyExport): Promise<GrocyImportReport> {
  const problems = [...data.problems];
  const report: GrocyImportReport = { products: { created: 0, updated: 0, unchanged: 0 }, foods: { created: 0, linked: 0 }, problems };

  const units = await pool.request().query("SELECT id, name, abbreviation FROM unit");
  const unitIds = new Map<string, string>();
  const abbreviations = new Map<string, string>();
  for (const u of units.recordset) {
    unitIds.set(String(u.name).toLowerCase(), u.id);
    unitIds.set(String(u.abbreviation).toLowerCase(), u.id);
    abbreviations.set(String(u.id).toLowerCase(), String(u.abbreviation));
  }
  const grocyUnits = new Map<string, string>();
  for (const u of data.units) if (u.id !== undefined && typeof u.name === "string") grocyUnits.set(String(u.id), u.name);

  const stockByProduct = new Map<string, number>();
  for (const row of data.stock) {
    const amount = num(row.amount);
    if (row.product_id !== undefined && amount !== undefined) {
      const key = String(row.product_id);
      stockByProduct.set(key, (stockByProduct.get(key) ?? 0) + amount);
    }
  }

  function map(raw: Json): Mapped | undefined {
    const grocyId = raw.id === undefined || raw.id === null ? "" : String(raw.id);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!grocyId || !name || name.length > 200) {
      problems.push(`A product (${name || grocyId || "no name"}) has no usable name or id and was skipped.`);
      return undefined;
    }
    if (raw.active === 0 || raw.active === "0" || raw.active === false) {
      problems.push(`Product "${name}" is inactive in Grocy, so it was skipped.`);
      return undefined;
    }

    const grocyUnit = grocyUnits.get(String(raw.qu_id_stock));
    let unitId = grocyUnit === undefined ? undefined : matchUnit(unitIds, grocyUnit);
    if (!unitId) {
      problems.push(`Product "${name}": its unit "${grocyUnit ?? raw.qu_id_stock}" isn't a known unit, so it is counted in "each".`);
      unitId = unitIds.get("ea");
    }
    if (!unitId) throw new Error("The unit table has no 'each' unit.");

    const stock = round4(Math.max(0, stockByProduct.get(grocyId) ?? 0));
    const staple = (num(raw.min_stock_amount) ?? 0) > 0;

    // Grocy's last_price is per stock unit; the pantry keeps a price per package, so it is
    // scaled by the size Grocy buys the product in (1 when Grocy has no such size).
    let price: Price | null = null;
    const details = data.details[grocyId];
    const lastPrice = details ? num(details.last_price) : undefined;
    if (lastPrice !== undefined && lastPrice > 0) {
      const factor = num(raw.qu_factor_purchase_to_stock);
      const date = typeof details?.last_purchased === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(details.last_purchased)?.[0] : undefined;
      const candidate = date ? { priceCents: Math.round(lastPrice * (factor && factor > 0 ? factor : 1) * 100), packageQuantity: round4(factor && factor > 0 ? factor : 1), date } : undefined;
      try {
        if (!candidate) throw new Error("it has no purchase date");
        validatePrice(candidate);
        price = candidate;
      } catch (error) {
        problems.push(`Product "${name}": its price wasn't imported (${errorText(error)})`);
      }
    } else if (details) {
      problems.push(`Product "${name}" has no price in Grocy, so it was imported with no price.`);
    }
    return { grocyId, name, unit: abbreviations.get(unitId.toLowerCase()) ?? "", unitId, stock, staple, price };
  }

  const h = (db: mssql.Transaction) => new mssql.Request(db).input("h", GUID, householdId);

  async function foodFor(tx: mssql.Transaction, name: string): Promise<string> {
    const found = await h(tx).input("name", mssql.NVarChar(200), name).query("SELECT id FROM food WHERE household_id = @h AND name = @name");
    const existing = found.recordset[0]?.id as string | undefined;
    if (existing) {
      report.foods.linked++;
      return existing;
    }
    const added = await h(tx).input("name", mssql.NVarChar(200), name).query("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @name)");
    report.foods.created++;
    return added.recordset[0].id as string;
  }

  for (const raw of data.products) {
    const product = map(raw);
    if (!product) continue;
    const print = fingerprint({ unit: product.unit, stock: product.stock, staple: product.staple, price: product.price });
    const foodsBefore = { ...report.foods };
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      const link = await h(tx)
        .input("ext", mssql.NVarChar(200), product.grocyId)
        .query("SELECT local_id, fingerprint FROM import_source WHERE household_id = @h AND source = 'grocy' AND kind = 'product' AND external_id = @ext");
      const known = link.recordset[0] as { local_id: string; fingerprint: string | null } | undefined;
      const present =
        known !== undefined &&
        (await h(tx).input("id", GUID, known.local_id).query("SELECT 1 AS found FROM product WHERE id = @id AND household_id = @h")).recordset.length > 0;

      let localId: string;
      let outcome: keyof Tally;
      if (known && present) {
        if (known.fingerprint === print) {
          await tx.commit();
          report.products.unchanged++;
          continue;
        }
        localId = known.local_id;
        const r = h(tx).input("id", GUID, localId).input("unit", GUID, product.unitId).input("stock", mssql.Decimal(18, 4), product.stock).input("staple", mssql.Bit, product.staple);
        await r.query("UPDATE product SET unit_id = @unit, stock_quantity = @stock, is_staple = @staple WHERE id = @id AND household_id = @h");
        outcome = "updated";
      } else {
        const foodId = await foodFor(tx, product.name);
        const added = await h(tx)
          .input("food", GUID, foodId)
          .input("name", mssql.NVarChar(200), product.name)
          .input("unit", GUID, product.unitId)
          .input("stock", mssql.Decimal(18, 4), product.stock)
          .input("staple", mssql.Bit, product.staple)
          .query(
            `INSERT product (household_id, food_id, name, unit_id, stock_quantity, is_staple)
             OUTPUT inserted.id VALUES (@h, @food, @name, @unit, @stock, @staple)`,
          );
        localId = added.recordset[0].id as string;
        outcome = "created";
      }
      // Grocy is the source of truth until switch-over, so its latest price replaces the stored one.
      await h(tx)
        .input("id", GUID, localId)
        .input("cents", mssql.Int, product.price?.priceCents ?? null)
        .input("size", mssql.Decimal(18, 4), product.price?.packageQuantity ?? null)
        .input("date", mssql.Date, product.price?.date ?? null)
        .query("UPDATE product SET price_cents = @cents, package_quantity = @size, price_date = @date WHERE id = @id AND household_id = @h");
      await h(tx)
        .input("ext", mssql.NVarChar(200), product.grocyId)
        .input("local", GUID, localId)
        .input("print", mssql.Char(64), print)
        .query(`
          UPDATE import_source SET local_id = @local, fingerprint = @print, imported_at = SYSUTCDATETIME()
          WHERE household_id = @h AND source = 'grocy' AND kind = 'product' AND external_id = @ext;
          IF @@ROWCOUNT = 0
            INSERT import_source (household_id, source, kind, external_id, local_id, fingerprint)
            VALUES (@h, 'grocy', 'product', @ext, @local, @print);`);
      await tx.commit();
      report.products[outcome]++;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      Object.assign(report.foods, foodsBefore); // the food it counted was rolled back
      problems.push(`Product "${product.name}" couldn't be imported: ${errorText(error)}`);
    }
  }
  return report;
}

/** The report as plain lines, for the person running the import. */
export function formatReport(report: GrocyImportReport): string {
  const t = report.products;
  return [
    `Products: ${t.created} new, ${t.updated} updated, ${t.unchanged} unchanged`,
    `Foods: ${report.foods.created} new, ${report.foods.linked} matched to a food you already had`,
    report.problems.length
      ? `\n${report.problems.length} thing(s) couldn't be carried over exactly:\n${report.problems.map((p) => `  - ${p}`).join("\n")}`
      : "\nNothing was left behind.",
  ].join("\n");
}
