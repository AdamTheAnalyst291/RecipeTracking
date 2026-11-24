import mssql from "mssql";
import { calculateNeeds, type Convert, type PlannedLine, type StockLine } from "./shoppingNeeds.js";

/** One line on a shopping list. `quantity` and the unit are null for a line with no amount. */
export interface ShoppingItem {
  id: string;
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  unitId: string | null;
  /** `plan`: worked out from the meal plan. `manual`: added by hand. */
  source: "plan" | "manual";
  checked: boolean;
}

/** A list built for the days `start` to `end` inclusive (`YYYY-MM-DD`). `createdAt` is ISO 8601, UTC. */
export interface ShoppingList {
  id: string;
  start: string;
  end: string;
  createdAt: string;
  items: ShoppingItem[];
}

export interface NewShoppingItem {
  name: string;
  quantity?: number;
  unitId?: string;
}

/** `not-found`: no such list, item or unit in this household. `invalid`: a value that can't be stored. */
export class ShoppingListError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ShoppingListError";
  }
}

export interface ShoppingLists {
  /** The household's most recent list, or undefined when it has none. */
  latest(householdId: string): Promise<ShoppingList | undefined>;
  /**
   * Builds a new list from the planned meals on the days `start` to `end` inclusive: foods
   * totalled over the recipes, staples' stock taken off, untracked foods kept. The previous
   * list's hand-added items that were not yet checked off come along. Older lists are kept.
   */
  generate(householdId: string, start: string, end: string): Promise<ShoppingList>;
  addItem(householdId: string, listId: string, item: NewShoppingItem): Promise<ShoppingItem>;
  setChecked(householdId: string, listId: string, itemId: string, checked: boolean): Promise<ShoppingItem>;
  removeItem(householdId: string, listId: string, itemId: string): Promise<void>;
}

const MAX_DAYS = 62;
const MAX_QUANTITY = 99_999_999;

function checkDate(value: unknown, what: string): asserts value is string {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ShoppingListError("invalid", `${what} must be a date like 2026-11-22.`);
  }
}

const itemSelect = `
  SELECT i.id, i.food_id AS foodId, i.name, i.quantity, u.abbreviation AS unit, i.unit_id AS unitId, i.source, i.checked
  FROM shopping_list_item i LEFT JOIN unit u ON u.id = i.unit_id`;

interface ItemRow {
  id: string;
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  unitId: string | null;
  source: "plan" | "manual";
  checked: boolean;
}

const toItem = (row: ItemRow): ShoppingItem => ({
  id: String(row.id).toLowerCase(),
  foodId: row.foodId === null ? null : String(row.foodId).toLowerCase(),
  name: row.name,
  quantity: row.quantity === null ? null : Number(row.quantity),
  unit: row.unit,
  unitId: row.unitId === null ? null : String(row.unitId).toLowerCase(),
  source: row.source,
  checked: Boolean(row.checked),
});

export function createShoppingLists(pool: mssql.ConnectionPool): ShoppingLists {
  const GUID = mssql.UniqueIdentifier;

  async function itemsOf(request: () => mssql.Request, listId: string, householdId: string): Promise<ShoppingItem[]> {
    const r = await request()
      .input("h", GUID, householdId)
      .input("l", GUID, listId)
      .query(`${itemSelect} WHERE i.list_id = @l AND i.household_id = @h ORDER BY i.checked, i.name, i.created_at, i.id`);
    return (r.recordset as ItemRow[]).map(toItem);
  }

  async function getItem(householdId: string, listId: string, itemId: string): Promise<ShoppingItem | undefined> {
    const r = await pool
      .request()
      .input("h", GUID, householdId)
      .input("l", GUID, listId)
      .input("i", GUID, itemId)
      .query(`${itemSelect} WHERE i.id = @i AND i.list_id = @l AND i.household_id = @h`);
    const row = r.recordset[0] as ItemRow | undefined;
    return row && toItem(row);
  }

  return {
    async latest(householdId) {
      const r = await pool
        .request()
        .input("h", GUID, householdId)
        .query(
          `SELECT TOP 1 id, CONVERT(CHAR(10), start_date, 23) AS start, CONVERT(CHAR(10), end_date, 23) AS [end], created_at
           FROM shopping_list WHERE household_id = @h ORDER BY created_at DESC, id DESC`,
        );
      const row = r.recordset[0] as { id: string; start: string; end: string; created_at: Date } | undefined;
      if (!row) return undefined;
      const id = String(row.id).toLowerCase();
      return {
        id,
        start: row.start,
        end: row.end,
        createdAt: row.created_at.toISOString(),
        items: await itemsOf(() => pool.request(), id, householdId),
      };
    },

    async generate(householdId, start, end) {
      checkDate(start, "The start");
      checkDate(end, "The end");
      const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
      if (days < 1) throw new ShoppingListError("invalid", "The end can't be before the start.");
      if (days > MAX_DAYS) throw new ShoppingListError("invalid", `A list can cover at most ${MAX_DAYS} days.`);

      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        const request = () =>
          new mssql.Request(tx).input("h", GUID, householdId).input("start", mssql.Date, start).input("end", mssql.Date, end);

        const planned = (
          await request().query(
            `SELECT i.food_id, f.name AS food, i.quantity, i.unit_id, u.abbreviation AS unit, u.kind AS unit_kind,
                    r.servings AS recipe_servings, m.servings AS planned_servings
             FROM planned_meal m
             JOIN recipe r ON r.id = m.recipe_id AND r.household_id = m.household_id
             JOIN recipe_ingredient i ON i.recipe_id = r.id
             JOIN food f ON f.id = i.food_id
             LEFT JOIN unit u ON u.id = i.unit_id
             WHERE m.household_id = @h AND m.plan_date >= @start AND m.plan_date <= @end
             ORDER BY m.plan_date,
               CASE m.meal_slot WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END,
               m.created_at, m.id, i.position`,
          )
        ).recordset.map(
          (row): PlannedLine => ({
            foodId: String(row.food_id),
            food: row.food,
            quantity: row.quantity === null ? null : Number(row.quantity),
            unitId: row.unit_id === null ? null : String(row.unit_id),
            unit: row.unit,
            unitKind: row.unit_kind,
            recipeServings: row.recipe_servings,
            plannedServings: row.planned_servings,
          }),
        );

        const stock = (
          await request().query(
            `SELECT p.food_id, p.stock_quantity, p.unit_id, u.kind AS unit_kind
             FROM product p JOIN unit u ON u.id = p.unit_id
             WHERE p.household_id = @h AND p.is_staple = 1`,
          )
        ).recordset.map(
          (row): StockLine => ({
            foodId: String(row.food_id),
            quantity: Number(row.stock_quantity),
            unitId: String(row.unit_id),
            unitKind: row.unit_kind,
          }),
        );

        const factors = new Map<string, number>();
        for (const row of (await new mssql.Request(tx).query("SELECT from_unit_id, to_unit_id, factor FROM unit_conversion")).recordset) {
          factors.set(`${String(row.from_unit_id).toLowerCase()}>${String(row.to_unit_id).toLowerCase()}`, Number(row.factor));
        }
        const convert: Convert = (from, to) => factors.get(`${from.toLowerCase()}>${to.toLowerCase()}`);

        const needs = calculateNeeds(planned, stock, convert);

        const previous = (
          await request().query("SELECT TOP 1 id FROM shopping_list WITH (UPDLOCK, HOLDLOCK) WHERE household_id = @h ORDER BY created_at DESC, id DESC")
        ).recordset[0] as { id: string } | undefined;

        const list = (
          await request().query(
            `INSERT shopping_list (household_id, start_date, end_date)
             OUTPUT inserted.id, inserted.created_at
             VALUES (@h, @start, @end)`,
          )
        ).recordset[0] as { id: string; created_at: Date };

        for (const need of needs) {
          await request()
            .input("l", GUID, list.id)
            .input("food", GUID, need.foodId)
            .input("name", mssql.NVarChar(200), need.food)
            .input("quantity", mssql.Decimal(12, 4), need.quantity)
            .input("unit", GUID, need.unitId)
            .query(
              `INSERT shopping_list_item (list_id, household_id, food_id, name, quantity, unit_id, source)
               VALUES (@l, @h, @food, @name, @quantity, @unit, 'plan')`,
            );
        }

        if (previous) {
          await request()
            .input("l", GUID, list.id)
            .input("old", GUID, previous.id)
            .query(
              `INSERT shopping_list_item (list_id, household_id, food_id, name, quantity, unit_id, source)
               SELECT @l, household_id, food_id, name, quantity, unit_id, 'manual'
               FROM shopping_list_item
               WHERE list_id = @old AND household_id = @h AND source = 'manual' AND checked = 0`,
            );
        }

        const items = await itemsOf(() => new mssql.Request(tx), list.id, householdId);
        await tx.commit();
        return { id: String(list.id).toLowerCase(), start, end, createdAt: list.created_at.toISOString(), items };
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    },

    async addItem(householdId, listId, item) {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name.length === 0 || name.length > 200) throw new ShoppingListError("invalid", "The item needs a name of up to 200 characters.");
      if (item.quantity !== undefined && (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > MAX_QUANTITY)) {
        throw new ShoppingListError("invalid", "The amount must be a number above 0.");
      }
      if (item.unitId !== undefined && item.quantity === undefined) {
        throw new ShoppingListError("invalid", "A unit needs an amount.");
      }
      const r = await pool
        .request()
        .input("h", GUID, householdId)
        .input("l", GUID, listId)
        .input("name", mssql.NVarChar(200), name)
        .input("quantity", mssql.Decimal(12, 4), item.quantity ?? null)
        .input("unit", GUID, item.unitId ?? null)
        .query(
          `INSERT shopping_list_item (list_id, household_id, name, quantity, unit_id, source)
           OUTPUT inserted.id
           SELECT l.id, l.household_id, @name, @quantity, @unit, 'manual'
           FROM shopping_list l WHERE l.id = @l AND l.household_id = @h`,
        ).catch((error: unknown) => {
          // The unit foreign key is the only thing that can refuse a valid-looking item here.
          if (error instanceof mssql.RequestError && error.number === 547) throw new ShoppingListError("not-found", "No such unit.");
          throw error;
        });
      const id = r.recordset[0]?.id as string | undefined;
      if (!id) throw new ShoppingListError("not-found", "No such shopping list.");
      return (await getItem(householdId, listId, id)) as ShoppingItem;
    },

    async setChecked(householdId, listId, itemId, checked) {
      const r = await pool
        .request()
        .input("h", GUID, householdId)
        .input("l", GUID, listId)
        .input("i", GUID, itemId)
        .input("checked", mssql.Bit, checked)
        .query("UPDATE shopping_list_item SET checked = @checked OUTPUT inserted.id WHERE id = @i AND list_id = @l AND household_id = @h");
      if (r.recordset.length === 0) throw new ShoppingListError("not-found", "No such item.");
      return (await getItem(householdId, listId, itemId)) as ShoppingItem;
    },

    async removeItem(householdId, listId, itemId) {
      const r = await pool
        .request()
        .input("h", GUID, householdId)
        .input("l", GUID, listId)
        .input("i", GUID, itemId)
        .query("DELETE shopping_list_item OUTPUT deleted.id WHERE id = @i AND list_id = @l AND household_id = @h");
      if (r.recordset.length === 0) throw new ShoppingListError("not-found", "No such item.");
    },
  };
}
