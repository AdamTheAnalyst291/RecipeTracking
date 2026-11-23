import mssql from "mssql";

/** One pantry product that was drawn down, with how much (in the product's own unit). */
export interface UsedStock {
  product: string;
  amount: number;
  unit: string;
}

/** Stock that ran short: how much of a food the recipe wanted that the pantry didn't have (in the recipe's unit). */
export interface Shortfall {
  food: string;
  amount: number;
  unit: string;
}

export interface CookResult {
  eventId: string;
  recipeId: string;
  servingsMade: number;
  /** ISO 8601, UTC. */
  cookedAt: string;
  used: UsedStock[];
  shortfalls: Shortfall[];
}

export interface CookOptions {
  /** Defaults to the recipe's own servings, or 1 if it has none. */
  servingsMade?: number;
}

/** `not-found`: no such recipe in this household. `invalid`: a servings value that can't be used. */
export class CookingError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "CookingError";
  }
}

export interface Cooking {
  /**
   * "I made this": takes each ingredient out of the matching pantry products' stock (scaled
   * to the servings made, converted between units of one kind), then records a cooked event.
   * Foods with no product, lines with no amount and units that can't be converted are left
   * alone, and stock stops at 0. All of it happens in one transaction.
   */
  cook(householdId: string, recipeId: string, options?: CookOptions): Promise<CookResult>;
}

const MAX_SERVINGS = 10_000;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

interface IngredientRow {
  food_id: string;
  food: string;
  quantity: number;
  unit_id: string;
  unit: string;
}

interface ProductRow {
  id: string;
  food_id: string;
  name: string;
  unit_id: string;
  unit: string;
  stock: number;
}

export function createCooking(pool: mssql.ConnectionPool): Cooking {
  const GUID = mssql.UniqueIdentifier;

  return {
    async cook(householdId, recipeId, options = {}) {
      const requested = options.servingsMade;
      if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0 || requested > MAX_SERVINGS)) {
        throw new CookingError("invalid", `Servings made must be a number above 0 and at most ${MAX_SERVINGS}.`);
      }

      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        const request = () => new mssql.Request(tx).input("h", GUID, householdId).input("r", GUID, recipeId);

        const recipe = (
          await request().query(
            "SELECT name, servings FROM recipe WITH (UPDLOCK, HOLDLOCK) WHERE id = @r AND household_id = @h",
          )
        ).recordset[0] as { name: string; servings: number | null } | undefined;
        if (!recipe) throw new CookingError("not-found", "No such recipe.");

        const servingsMade = Math.round((requested ?? recipe.servings ?? 1) * 100) / 100;
        if (servingsMade <= 0) throw new CookingError("invalid", "Servings made must be at least 0.01.");
        const scale = recipe.servings ? servingsMade / recipe.servings : 1;

        const ingredients = (
          await request().query(
            `SELECT i.food_id, f.name AS food, i.quantity, i.unit_id, u.abbreviation AS unit
             FROM recipe_ingredient i
             JOIN food f ON f.id = i.food_id
             JOIN unit u ON u.id = i.unit_id
             WHERE i.recipe_id = @r AND i.quantity IS NOT NULL
             ORDER BY i.position`,
          )
        ).recordset.map((row) => ({ ...row, quantity: Number(row.quantity) })) as IngredientRow[];

        // Locked until the end, so two cooks at once can't both spend the same stock.
        const products = (
          await request().query(
            `SELECT p.id, p.food_id, p.name, p.unit_id, u.abbreviation AS unit, p.stock_quantity AS stock
             FROM product p WITH (UPDLOCK, ROWLOCK) JOIN unit u ON u.id = p.unit_id
             WHERE p.household_id = @h
               AND p.food_id IN (SELECT food_id FROM recipe_ingredient WHERE recipe_id = @r)
             ORDER BY p.name, p.id`,
          )
        ).recordset.map((row) => ({ ...row, stock: Number(row.stock) })) as ProductRow[];

        const conversions = new Map<string, number>();
        for (const row of (await new mssql.Request(tx).query("SELECT from_unit_id, to_unit_id, factor FROM unit_conversion")).recordset) {
          conversions.set(`${String(row.from_unit_id).toLowerCase()}>${String(row.to_unit_id).toLowerCase()}`, Number(row.factor));
        }
        /** How many of `to` one of `from` is, or undefined when they aren't the same kind of unit. */
        const factor = (from: string, to: string): number | undefined =>
          from.toLowerCase() === to.toLowerCase() ? 1 : conversions.get(`${from.toLowerCase()}>${to.toLowerCase()}`);

        const taken = new Map<string, number>(); // product id -> total taken
        const used: UsedStock[] = [];
        const shortfalls: Shortfall[] = [];

        for (const ingredient of ingredients) {
          let remaining = round4(ingredient.quantity * scale); // in the ingredient's unit
          let tracked = false;
          for (const product of products) {
            if (remaining <= 0) break;
            if (product.food_id.toLowerCase() !== ingredient.food_id.toLowerCase()) continue;
            const f = factor(ingredient.unit_id, product.unit_id);
            if (f === undefined) continue;
            tracked = true;
            const wanted = round4(remaining * f); // in the product's unit
            const take = Math.min(product.stock, wanted);
            if (take <= 0) continue;
            product.stock = round4(product.stock - take);
            taken.set(product.id, round4((taken.get(product.id) ?? 0) + take));
            remaining = take >= wanted ? 0 : round4(remaining - take / f);
            const earlier = used.find((u) => u.product === product.name && u.unit === product.unit);
            if (earlier) earlier.amount = round4(earlier.amount + take);
            else used.push({ product: product.name, amount: take, unit: product.unit });
          }
          if (tracked && remaining > 0) shortfalls.push({ food: ingredient.food, amount: remaining, unit: ingredient.unit });
        }

        for (const [productId, amount] of taken) {
          const updated = await new mssql.Request(tx)
            .input("h", GUID, householdId)
            .input("p", GUID, productId)
            .input("amount", mssql.Decimal(18, 4), amount)
            .query(
              `UPDATE product SET stock_quantity = stock_quantity - @amount
               WHERE id = @p AND household_id = @h AND stock_quantity - @amount >= 0`,
            );
          if (updated.rowsAffected[0] !== 1) throw new Error("Pantry stock changed while cooking; nothing was saved.");
        }

        const event = (
          await request()
            .input("name", mssql.NVarChar(200), recipe.name)
            .input("servings", mssql.Decimal(9, 2), servingsMade)
            .query(
              `INSERT cooked_event (household_id, recipe_id, recipe_name, servings_made)
               OUTPUT inserted.id, inserted.cooked_at
               VALUES (@h, @r, @name, @servings)`,
            )
        ).recordset[0] as { id: string; cooked_at: Date };

        await tx.commit();
        return {
          eventId: String(event.id).toLowerCase(),
          recipeId: recipeId.toLowerCase(),
          servingsMade,
          cookedAt: event.cooked_at.toISOString(),
          used,
          shortfalls,
        };
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    },
  };
}
