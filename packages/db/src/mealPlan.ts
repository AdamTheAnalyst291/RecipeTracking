import mssql from "mssql";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

const MAX_SERVINGS = 1000;

/** A recipe planned for a day and meal slot. `date` is `YYYY-MM-DD`. */
export interface PlannedMeal {
  id: string;
  date: string;
  slot: MealSlot;
  recipeId: string;
  recipeName: string;
  servings: number;
}

export interface NewPlannedMeal {
  date: string;
  slot: MealSlot;
  recipeId: string;
  /** Defaults to the recipe's servings, or 1 when it has none. */
  servings?: number;
}

/** Any of these, at least one. Changing `date` or `slot` moves the meal. */
export interface PlannedMealChange {
  date?: string;
  slot?: MealSlot;
  servings?: number;
}

/** `not-found`: no such meal or recipe in this household. `invalid`: a value that can't be stored. */
export class MealPlanError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "MealPlanError";
  }
}

export interface MealPlan {
  /** The meals on the seven days from `start` (`YYYY-MM-DD`), by date, then breakfast to snack. */
  listWeek(householdId: string, start: string): Promise<PlannedMeal[]>;
  add(householdId: string, meal: NewPlannedMeal): Promise<PlannedMeal>;
  update(householdId: string, mealId: string, change: PlannedMealChange): Promise<PlannedMeal>;
  remove(householdId: string, mealId: string): Promise<void>;
}

/** Accepts only a real calendar date written `YYYY-MM-DD`. */
function checkDate(value: unknown, what: string): asserts value is string {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MealPlanError("invalid", `${what} must be a date like 2026-11-22.`);
  }
}

function checkSlot(value: unknown): asserts value is MealSlot {
  if (!MEAL_SLOTS.includes(value as MealSlot)) throw new MealPlanError("invalid", `The meal must be one of ${MEAL_SLOTS.join(", ")}.`);
}

function checkServings(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SERVINGS) {
    throw new MealPlanError("invalid", `Servings must be a whole number from 1 to ${MAX_SERVINGS}.`);
  }
}

const select = `
  SELECT m.id, CONVERT(CHAR(10), m.plan_date, 23) AS date, m.meal_slot AS slot,
         m.recipe_id AS recipeId, r.name AS recipeName, m.servings
  FROM planned_meal m JOIN recipe r ON r.id = m.recipe_id AND r.household_id = m.household_id`;

export function createMealPlan(pool: mssql.ConnectionPool): MealPlan {
  async function get(householdId: string, mealId: string): Promise<PlannedMeal | undefined> {
    const r = await pool
      .request()
      .input("h", mssql.UniqueIdentifier, householdId)
      .input("m", mssql.UniqueIdentifier, mealId)
      .query(`${select} WHERE m.household_id = @h AND m.id = @m`);
    return r.recordset[0] as PlannedMeal | undefined;
  }

  return {
    async listWeek(householdId, start) {
      checkDate(start, "The week start");
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("start", mssql.Date, start)
        .query(`${select}
          WHERE m.household_id = @h AND m.plan_date >= CONVERT(DATE, @start) AND m.plan_date < DATEADD(DAY, 7, CONVERT(DATE, @start))
          ORDER BY m.plan_date,
            CASE m.meal_slot WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END,
            m.created_at, m.id`);
      return r.recordset as PlannedMeal[];
    },

    async add(householdId, meal) {
      checkDate(meal.date, "The date");
      checkSlot(meal.slot);
      if (meal.servings !== undefined) checkServings(meal.servings);
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("r", mssql.UniqueIdentifier, meal.recipeId)
        .input("date", mssql.Date, meal.date)
        .input("slot", mssql.VarChar(10), meal.slot)
        .input("servings", mssql.Int, meal.servings ?? null)
        .query(`
          INSERT planned_meal (household_id, plan_date, meal_slot, recipe_id, servings)
          OUTPUT inserted.id
          SELECT r.household_id, CONVERT(DATE, @date), @slot, r.id, COALESCE(@servings, r.servings, 1)
          FROM recipe r WHERE r.id = @r AND r.household_id = @h`);
      const id = r.recordset[0]?.id as string | undefined;
      if (!id) throw new MealPlanError("not-found", "No such recipe.");
      return (await get(householdId, id)) as PlannedMeal;
    },

    async update(householdId, mealId, change) {
      const sets: string[] = [];
      const request = pool.request().input("h", mssql.UniqueIdentifier, householdId).input("m", mssql.UniqueIdentifier, mealId);
      if (change.date !== undefined) {
        checkDate(change.date, "The date");
        request.input("date", mssql.Date, change.date);
        sets.push("plan_date = CONVERT(DATE, @date)");
      }
      if (change.slot !== undefined) {
        checkSlot(change.slot);
        request.input("slot", mssql.VarChar(10), change.slot);
        sets.push("meal_slot = @slot");
      }
      if (change.servings !== undefined) {
        checkServings(change.servings);
        request.input("servings", mssql.Int, change.servings);
        sets.push("servings = @servings");
      }
      if (sets.length === 0) throw new MealPlanError("invalid", "Send at least one of date, slot or servings.");
      const r = await request.query(`UPDATE planned_meal SET ${sets.join(", ")} OUTPUT inserted.id WHERE household_id = @h AND id = @m`);
      if (r.recordset.length === 0) throw new MealPlanError("not-found", "No such planned meal.");
      return (await get(householdId, mealId)) as PlannedMeal;
    },

    async remove(householdId, mealId) {
      const r = await pool
        .request()
        .input("h", mssql.UniqueIdentifier, householdId)
        .input("m", mssql.UniqueIdentifier, mealId)
        .query("DELETE planned_meal OUTPUT deleted.id WHERE household_id = @h AND id = @m");
      if (r.recordset.length === 0) throw new MealPlanError("not-found", "No such planned meal.");
    },
  };
}
