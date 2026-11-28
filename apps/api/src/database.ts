import { connectEntra, createBanks, createBudgets, createCooking, createMealPlan, createMoney, createPantry, createReceiptReminders, createReceipts, createShoppingLists, resolveHousehold, type Pantry } from "@kitchen/db";
import type { BankAccess } from "./functions/banks.js";
import type { CookingAccess } from "./functions/cooking.js";
import type { MealPlanAccess } from "./functions/mealPlan.js";
import type { ReceiptAccess } from "./mcp/receiptTool.js";
import type { BudgetAccess } from "./functions/budgets.js";
import type { MoneyAccess } from "./functions/money.js";
import type { PantryAccess } from "./functions/pantry.js";
import type { ShoppingListAccess } from "./functions/shoppingList.js";
import { createSqlRecipeStore, type RecipeStore } from "./recipes/store.js";

type Pool = Awaited<ReturnType<typeof connectEntra>>;

let pool: Promise<Pool> | undefined;

/**
 * The app database, opened on first use with the Functions app's managed identity (no
 * password). Needs `SQL_SERVER` (like sql-kitchen-dev-abc123.database.windows.net) and
 * `SQL_DATABASE` in the app settings.
 */
export function getPool(env: Record<string, string | undefined> = process.env): Promise<Pool> {
  if (!pool) {
    const server = env.SQL_SERVER?.trim();
    const database = env.SQL_DATABASE?.trim();
    if (!server || !database) return Promise.reject(new Error("SQL_SERVER and SQL_DATABASE are not set"));
    pool = connectEntra({ server, database }).catch((error: unknown) => {
      pool = undefined; // try again on the next request
      throw error;
    });
  }
  return pool;
}

/** The pantry for the signed-in member's household, against the real database. */
export const pantryAccess: PantryAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { pantry: createPantry(db), householdId };
};

/** The meal plan for the signed-in member's household, against the real database. */
export const mealPlanAccess: MealPlanAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { plan: createMealPlan(db), householdId };
};

/** The pantry across every household, for jobs that run without anyone signed in. */
export async function pantryForJobs(): Promise<Pantry> {
  return createPantry(await getPool());
}

/** Which weeks have had their receipt reminder, for the weekly timer. */
export async function receiptRemindersForJobs() {
  return createReceiptReminders(await getPool());
}

/** Recipes, against the real database. */
export async function recipeStore(): Promise<RecipeStore> {
  return createSqlRecipeStore(await getPool());
}

/** Cooking ("I made this") for the signed-in member's household, against the real database. */
export const cookingAccess: CookingAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { cooking: createCooking(db), householdId };
};

/** Shopping lists for the signed-in member's household, against the real database. */
export const shoppingListAccess: ShoppingListAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { lists: createShoppingLists(db), householdId };
};

/** Receipts and the price ledger for the signed-in member's household, against the real database. */
export const receiptAccess: ReceiptAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { receipts: createReceipts(db), householdId };
};

/** Money (accounts, transactions, categories, rules) for the signed-in member's household, against the real database. */
export const moneyAccess: MoneyAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { money: createMoney(db), householdId };
};

/** Monthly category budgets and spend vs budget for the signed-in member's household, against the real database. */
export const budgetAccess: BudgetAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { budgets: createBudgets(db), householdId };
};

/** Bank connections (Plaid, card $2) and money for the signed-in member's household, against the real database. */
export const bankAccess: BankAccess = async (user) => {
  const db = await getPool();
  const householdId = await resolveHousehold(db, { objectId: user.objectId, displayName: user.name });
  return { banks: createBanks(db), money: createMoney(db), householdId };
};

/** Bank connections and money across every household, for the daily sync. */
export async function banksForJobs() {
  const db = await getPool();
  return { banks: createBanks(db), money: createMoney(db) };
}
