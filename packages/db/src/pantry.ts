import mssql from "mssql";

/** A product as the pantry shows it. Dates are `YYYY-MM-DD`. */
export interface Product {
  id: string;
  foodId: string;
  name: string;
  /** The unit stock and package size are counted in, such as `g`. */
  unit: string;
  unitId: string;
  stockQuantity: number;
  staple: boolean;
  /** The size the latest price is for, in `unit`. */
  packageQuantity: number | null;
  priceCents: number | null;
  priceDate: string | null;
}

export interface NewProduct {
  foodId: string;
  unitId: string;
  /** Defaults to the food's name. */
  name?: string;
  staple?: boolean;
  stockQuantity?: number;
}

export type StockChange = { set: number } | { delta: number };

export interface Price {
  priceCents: number;
  packageQuantity: number;
  date: string;
}

/** `not-found`: no such product, food or unit in this household. `invalid`: a value that can't be stored. */
export class PantryError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "PantryError";
  }
}

export interface Pantry {
  addProduct(householdId: string, product: NewProduct): Promise<Product>;
  listProducts(householdId: string): Promise<Product[]>;
  adjustStock(householdId: string, productId: string, change: StockChange): Promise<Product>;
  setStaple(householdId: string, productId: string, staple: boolean): Promise<Product>;
  setPrice(householdId: string, productId: string, price: Price): Promise<Product>;
  /**
   * Of these foods, the ones to assume we need: those no staple product tracks, and tracked
   * ones that have run out. Only staples are tracked, so anything else is "assume we need it".
   */
  needsBuying(householdId: string, foodIds: string[]): Promise<string[]>;
  /** Writes today's stock-and-price row for every product, replacing one already written for `date`. Returns the row count. */
  snapshotAll(date: string): Promise<number>;
}

const MAX_QUANTITY = 99_999_999_999_999; // DECIMAL(18, 4) holds 14 digits before the point
const MAX_PRICE_CENTS = 2_147_483_647;

const productSelect = `
  SELECT p.id, p.food_id AS foodId, p.name, u.abbreviation AS unit, p.unit_id AS unitId,
         p.stock_quantity AS stockQuantity, p.is_staple AS staple, p.package_quantity AS packageQuantity,
         p.price_cents AS priceCents, CONVERT(CHAR(10), p.price_date, 23) AS priceDate
  FROM product p JOIN unit u ON u.id = p.unit_id`;

interface ProductRow extends Omit<Product, "staple"> {
  staple: boolean | number;
}

function toProduct(row: ProductRow): Product {
  return { ...row, staple: Boolean(row.staple) };
}

function checkQuantity(value: number, what: string, { allowZero }: { allowZero: boolean }): void {
  if (!Number.isFinite(value) || value > MAX_QUANTITY || (allowZero ? value < 0 : value <= 0)) {
    throw new PantryError("invalid", `${what} must be a number ${allowZero ? "of 0 or more" : "above 0"}.`);
  }
}

/** Accepts only a real calendar date written `YYYY-MM-DD`. */
function checkDate(value: string, what: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  const valid = parsed !== undefined && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  if (!valid) throw new PantryError("invalid", `${what} must be a date like 2026-11-22.`);
}

export function createPantry(pool: mssql.ConnectionPool): Pantry {
  async function getProduct(householdId: string, productId: string): Promise<Product> {
    const r = await pool
      .request()
      .input("h", mssql.UniqueIdentifier, householdId)
      .input("p", mssql.UniqueIdentifier, productId)
      .query(`${productSelect} WHERE p.household_id = @h AND p.id = @p`);
    const row = r.recordset[0] as ProductRow | undefined;
    if (!row) throw new PantryError("not-found", "No such product.");
    return toProduct(row);
  }

  return {
    async addProduct(householdId, product) {
      const stock = product.stockQuantity ?? 0;
      checkQuantity(stock, "Stock", { allowZero: true });
      const name = product.name?.trim();
      if (product.name !== undefined && !name) throw new PantryError("invalid", "A product needs a name.");
      if ((name?.length ?? 0) > 200) throw new PantryError("invalid", "A product name can be at most 200 characters.");

      const unit = await pool.request().input("u", mssql.UniqueIdentifier, product.unitId).query("SELECT 1 AS ok FROM unit WHERE id = @u");
      if (unit.recordset.length === 0) throw new PantryError("not-found", "No such unit.");

      const inserted = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("f", mssql.UniqueIdentifier, product.foodId)
        .input("u", mssql.UniqueIdentifier, product.unitId)
        .input("name", mssql.NVarChar(200), name ?? null)
        .input("staple", mssql.Bit, product.staple ?? false)
        .input("stock", mssql.Decimal(18, 4), stock)
        .query(`
          INSERT product (household_id, food_id, name, unit_id, is_staple, stock_quantity)
          OUTPUT inserted.id
          SELECT f.household_id, f.id, COALESCE(@name, f.name), @u, @staple, @stock
          FROM food f WHERE f.id = @f AND f.household_id = @h`);
      const id = inserted.recordset[0]?.id as string | undefined;
      if (!id) throw new PantryError("not-found", "No such food.");
      return getProduct(householdId, id);
    },

    async listProducts(householdId) {
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .query(`${productSelect} WHERE p.household_id = @h ORDER BY p.name, p.id`);
      return (r.recordset as ProductRow[]).map(toProduct);
    },

    async adjustStock(householdId, productId, change) {
      const isSet = "set" in change;
      const amount = isSet ? change.set : change.delta;
      if (typeof amount !== "number" || !Number.isFinite(amount) || Math.abs(amount) > MAX_QUANTITY) {
        throw new PantryError("invalid", "The stock change must be a number.");
      }
      if (isSet && amount < 0) throw new PantryError("invalid", "Stock can't be below 0.");

      // One statement, so two changes at once both land, and stock never goes negative.
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("p", mssql.UniqueIdentifier, productId)
        .input("amount", mssql.Decimal(18, 4), amount)
        .query(`
          UPDATE product SET stock_quantity = ${isSet ? "@amount" : "stock_quantity + @amount"}
          OUTPUT inserted.id
          WHERE household_id = @h AND id = @p ${isSet ? "" : "AND stock_quantity + @amount >= 0"}`);
      if (r.recordset.length === 0) {
        // Either there is no such product or the change would take stock below 0.
        await getProduct(householdId, productId);
        throw new PantryError("invalid", "Stock can't go below 0.");
      }
      return getProduct(householdId, productId);
    },

    async setStaple(householdId, productId, staple) {
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("p", mssql.UniqueIdentifier, productId)
        .input("staple", mssql.Bit, staple)
        .query("UPDATE product SET is_staple = @staple OUTPUT inserted.id WHERE household_id = @h AND id = @p");
      if (r.recordset.length === 0) throw new PantryError("not-found", "No such product.");
      return getProduct(householdId, productId);
    },

    async setPrice(householdId, productId, price) {
      if (!Number.isInteger(price.priceCents) || price.priceCents < 0 || price.priceCents > MAX_PRICE_CENTS) {
        throw new PantryError("invalid", "The price must be a whole number of cents, 0 or more.");
      }
      checkQuantity(price.packageQuantity, "The package size", { allowZero: false });
      checkDate(price.date, "The price date");
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("p", mssql.UniqueIdentifier, productId)
        .input("cents", mssql.Int, price.priceCents)
        .input("size", mssql.Decimal(18, 4), price.packageQuantity)
        .input("date", mssql.Date, price.date)
        .query(`
          UPDATE product SET price_cents = @cents, package_quantity = @size, price_date = CONVERT(DATE, @date)
          OUTPUT inserted.id WHERE household_id = @h AND id = @p`);
      if (r.recordset.length === 0) throw new PantryError("not-found", "No such product.");
      return getProduct(householdId, productId);
    },

    async needsBuying(householdId, foodIds) {
      if (foodIds.length === 0) return [];
      const request = pool.request().input("h", mssql.UniqueIdentifier, householdId);
      const names = foodIds.map((id, i) => {
        request.input(`f${i}`, mssql.UniqueIdentifier, id);
        return `@f${i}`;
      });
      const r = await request.query(`
        SELECT DISTINCT p.food_id AS id FROM product p
        WHERE p.household_id = @h AND p.is_staple = 1 AND p.stock_quantity > 0 AND p.food_id IN (${names.join(", ")})`);
      const inStock = new Set((r.recordset as { id: string }[]).map((row) => row.id.toLowerCase()));
      return foodIds.filter((id) => !inStock.has(id.toLowerCase()));
    },

    async snapshotAll(date) {
      checkDate(date, "The snapshot date");
      const r = await pool
        .request()
        .input("date", mssql.Date, date)
        .query(`
          MERGE pantry_snapshot WITH (HOLDLOCK) AS s
          USING (SELECT id, stock_quantity, unit_id, package_quantity, price_cents, price_date FROM product) AS p
            ON s.product_id = p.id AND s.snapshot_date = CONVERT(DATE, @date)
          WHEN MATCHED THEN UPDATE SET stock_quantity = p.stock_quantity, unit_id = p.unit_id,
            package_quantity = p.package_quantity, price_cents = p.price_cents, price_date = p.price_date,
            taken_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (product_id, snapshot_date, stock_quantity, unit_id, package_quantity, price_cents, price_date)
            VALUES (p.id, CONVERT(DATE, @date), p.stock_quantity, p.unit_id, p.package_quantity, p.price_cents, p.price_date);
          SELECT @@ROWCOUNT AS written;`);
      return r.recordset[0].written as number;
    },
  };
}
