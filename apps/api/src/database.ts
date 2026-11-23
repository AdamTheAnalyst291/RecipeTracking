import { connectEntra, createPantry, resolveHousehold, type Pantry } from "@kitchen/db";
import type { PantryAccess } from "./functions/pantry.js";
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

/** The pantry across every household, for jobs that run without anyone signed in. */
export async function pantryForJobs(): Promise<Pantry> {
  return createPantry(await getPool());
}

/** Recipes, against the real database. */
export async function recipeStore(): Promise<RecipeStore> {
  return createSqlRecipeStore(await getPool());
}
