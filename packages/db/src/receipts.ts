import mssql from "mssql";
import { matchUnit } from "./mealie/map.js";

/** One line as it goes onto a receipt. */
export interface NewReceiptLine {
  /** The line as the receipt words it. */
  name: string;
  /** The kitchen's product or food this line is, when the receipt's own words don't say. */
  item?: string;
  /** Cents paid for the whole line; below 0 for a coupon or discount. */
  priceCents: number;
  /** How many packages; 1 when left out. */
  quantity?: number;
  /** The size of one package, in `unit`. */
  packageQuantity?: number;
  unit?: string;
}

export interface NewReceipt {
  store: string;
  /** `YYYY-MM-DD`. */
  date: string;
  totalCents: number;
  items: NewReceiptLine[];
  /** Save it even though one with this store, date and total is already saved. */
  secondPurchase?: boolean;
}

/** A line that matched a food, and a product when only one fits. */
export interface MatchedLine {
  line: number;
  name: string;
  food: string;
  product: string | null;
}

export interface UnmatchedLine {
  line: number;
  name: string;
  priceCents: number;
}

/** A staple that took its price from a line. The price is for one package of `packageQuantity` `unit`. */
export interface PriceUpdate {
  line: number;
  product: string;
  priceCents: number;
  packageQuantity: number;
  unit: string;
}

/** A matched product whose price was left as it was, and why. */
export interface PriceKept {
  line: number;
  product: string;
  reason: string;
}

export interface SavedReceipt {
  id: string;
  store: string;
  date: string;
  totalCents: number;
  /** What the lines add up to, to compare with the total. */
  linesCents: number;
  lines: number;
  matched: MatchedLine[];
  unmatched: UnmatchedLine[];
  pricesUpdated: PriceUpdate[];
  pricesNotUpdated: PriceKept[];
}

/** A receipt that can't be saved, worded for the person. */
export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

export interface Receipts {
  /**
   * Saves every line to the price ledger and matches each to a food and product. A matched
   * staple takes the line's price, dated the receipt's date, unless the price on record is
   * from that day or later. All or nothing. Refuses a receipt already saved (same store, date and
   * total) unless it is marked as a second purchase.
   */
  add(householdId: string, receipt: NewReceipt): Promise<SavedReceipt>;
}

/** Names match when they read the same, ignoring case and extra spaces. Nothing fuzzier: a wrong match would be a wrong price. */
const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

function grouped<T>(items: T[], by: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(by(item), [...(groups.get(by(item)) ?? []), item]);
  return groups;
}

interface FoodRow {
  id: string;
  name: string;
}

interface ProductRow {
  id: string;
  foodId: string;
  name: string;
  food: string;
  staple: boolean;
  unit: string;
  unitId: string;
}

/** The package a line says was bought, in its product's unit, or why there isn't one to price from. */
function packagePrice(
  line: { priceCents: number; quantity: number; packageQuantity?: number; unit?: string; unitId: string | null },
  product: ProductRow,
  factors: ReadonlyMap<string, number>,
): { priceCents: number; packageQuantity: number } | string {
  if (line.priceCents <= 0) return "The line has no price paid.";
  if (line.packageQuantity === undefined || line.unitId === null) return "The line has no package size.";
  const factor = line.unitId === product.unitId ? 1 : factors.get(`${line.unitId} ${product.unitId}`);
  const size = factor === undefined ? 0 : Math.round(line.packageQuantity * factor * 10_000) / 10_000;
  if (size <= 0) return `The size in ${line.unit} can't be turned into ${product.unit}.`;
  return { priceCents: Math.round(line.priceCents / line.quantity), packageQuantity: size };
}

interface Match {
  foodId: string;
  food: string;
  product: ProductRow | null;
}

/** The household's foods and products, looked up by a line's name. */
function matcher(foods: FoodRow[], products: ProductRow[]) {
  const productsByName = grouped(products, (p) => key(p.name));
  const productsByFood = grouped(products, (p) => p.foodId);
  const foodsByName = new Map(foods.map((f) => [key(f.name), f]));

  return (name: string): Match | null => {
    const named = productsByName.get(key(name)) ?? [];
    const [only] = named;
    if (only && named.length === 1) return { foodId: only.foodId, food: only.food, product: only };
    const food = foodsByName.get(key(name));
    if (!food) return null;
    const ofFood = productsByFood.get(food.id) ?? [];
    return { foodId: food.id, food: food.name, product: ofFood.length === 1 ? (ofFood[0] ?? null) : null };
  };
}

export function createReceipts(pool: mssql.ConnectionPool): Receipts {
  return {
    async add(householdId, receipt) {
      const household = () => pool.request().input("h", mssql.UniqueIdentifier, householdId);
      const foods = (await household().query("SELECT id, name FROM food WHERE household_id = @h")).recordset as FoodRow[];
      const products = (
        await household().query(
          `SELECT p.id, p.food_id AS foodId, p.name, f.name AS food, p.is_staple AS staple, u.abbreviation AS unit, p.unit_id AS unitId
           FROM product p JOIN food f ON f.id = p.food_id JOIN unit u ON u.id = p.unit_id WHERE p.household_id = @h`,
        )
      ).recordset as ProductRow[];
      const units = (await pool.request().query("SELECT id, name, abbreviation FROM unit")).recordset as { id: string; name: string; abbreviation: string }[];
      const unitIds = new Map(units.flatMap((u) => [[u.name.toLowerCase(), u.id], [u.abbreviation.toLowerCase(), u.id]]));
      const match = matcher(foods, products);
      const conversions = (await pool.request().query("SELECT from_unit_id AS source, to_unit_id AS target, factor FROM unit_conversion")).recordset as {
        source: string;
        target: string;
        factor: number;
      }[];
      const factors = new Map(conversions.map((c) => [`${c.source} ${c.target}`, c.factor]));

      const lines = receipt.items.map((item, index) => {
        const unitId = item.unit === undefined ? null : matchUnit(unitIds, item.unit);
        if (unitId === undefined) {
          throw new ReceiptError(`"${item.unit}" isn't a known unit. The known units are: ${units.map((u) => u.abbreviation).join(", ")}.`);
        }
        return { ...item, no: index + 1, quantity: item.quantity ?? 1, unitId, match: match(item.item ?? item.name) };
      });

      const tx = new mssql.Transaction(pool);
      await tx.begin();
      let receiptId: string;
      const pricesUpdated: PriceUpdate[] = [];
      const pricesNotUpdated: PriceKept[] = [];
      try {
        if (!receipt.secondPurchase) {
          // The range lock holds until commit, so the same receipt sent twice at once is saved once.
          const saved = await new mssql.Request(tx)
            .input("h", mssql.UniqueIdentifier, householdId)
            .input("store", mssql.NVarChar(100), receipt.store)
            .input("date", mssql.Date, receipt.date)
            .input("total", mssql.Int, receipt.totalCents)
            .query(
              `SELECT TOP 1 id FROM receipt WITH (UPDLOCK, HOLDLOCK)
               WHERE household_id = @h AND receipt_date = CONVERT(DATE, @date) AND total_cents = @total AND store = @store`,
            );
          if (saved.recordset.length > 0) {
            throw new ReceiptError("A receipt from this store with this date and total is already saved.");
          }
        }

        const inserted = await new mssql.Request(tx)
          .input("h", mssql.UniqueIdentifier, householdId)
          .input("store", mssql.NVarChar(100), receipt.store)
          .input("date", mssql.Date, receipt.date)
          .input("total", mssql.Int, receipt.totalCents)
          .query("INSERT receipt (household_id, store, receipt_date, total_cents) OUTPUT inserted.id VALUES (@h, @store, CONVERT(DATE, @date), @total)");
        receiptId = String(inserted.recordset[0].id).toLowerCase();

        for (const line of lines) {
          await new mssql.Request(tx)
            .input("r", mssql.UniqueIdentifier, receiptId)
            .input("no", mssql.Int, line.no)
            .input("h", mssql.UniqueIdentifier, householdId)
            .input("name", mssql.NVarChar(200), line.name)
            .input("quantity", mssql.Int, line.quantity)
            .input("cents", mssql.Int, line.priceCents)
            .input("size", mssql.Decimal(18, 4), line.packageQuantity ?? null)
            .input("unit", mssql.UniqueIdentifier, line.unitId)
            .input("food", mssql.UniqueIdentifier, line.match?.foodId ?? null)
            .input("product", mssql.UniqueIdentifier, line.match?.product?.id ?? null)
            .query(
              `INSERT price_ledger (receipt_id, line_no, household_id, name, quantity, price_cents, package_quantity, unit_id, food_id, product_id)
               VALUES (@r, @no, @h, @name, @quantity, @cents, @size, @unit, @food, @product)`,
            );
        }

        for (const line of lines) {
          const product = line.match?.product;
          if (!product) continue;
          const keep = (reason: string) => pricesNotUpdated.push({ line: line.no, product: product.name, reason });
          if (!product.staple) {
            keep("Not a staple.");
            continue;
          }
          const price = packagePrice(line, product, factors);
          if (typeof price === "string") {
            keep(price);
            continue;
          }
          const updated = await new mssql.Request(tx)
            .input("h", mssql.UniqueIdentifier, householdId)
            .input("p", mssql.UniqueIdentifier, product.id)
            .input("cents", mssql.Int, price.priceCents)
            .input("size", mssql.Decimal(18, 4), price.packageQuantity)
            .input("date", mssql.Date, receipt.date)
            .query(
              `UPDATE product SET price_cents = @cents, package_quantity = @size, price_date = CONVERT(DATE, @date)
               OUTPUT inserted.id WHERE household_id = @h AND id = @p AND (price_date IS NULL OR price_date < CONVERT(DATE, @date));
               SELECT CONVERT(CHAR(10), price_date, 23) AS priceDate FROM product WHERE household_id = @h AND id = @p;`,
            );
          const [changed, now] = updated.recordsets as unknown as [unknown[], { priceDate: string }[]];
          if (changed.length > 0) pricesUpdated.push({ line: line.no, product: product.name, ...price, unit: product.unit });
          else keep(`The price on record is from ${now[0]?.priceDate}, so this receipt isn't newer.`);
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }

      return {
        id: receiptId,
        store: receipt.store,
        date: receipt.date,
        totalCents: receipt.totalCents,
        linesCents: lines.reduce((sum, l) => sum + l.priceCents, 0),
        lines: lines.length,
        matched: lines.flatMap((l) => (l.match ? [{ line: l.no, name: l.name, food: l.match.food, product: l.match.product?.name ?? null }] : [])),
        unmatched: lines.flatMap((l) => (l.match ? [] : [{ line: l.no, name: l.name, priceCents: l.priceCents }])),
        pricesUpdated,
        pricesNotUpdated,
      };
    },
  };
}
