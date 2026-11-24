import mssql from "mssql";
import type { MealieExport } from "./client.js";
import { fingerprint, mapMealPlanEntry, mapRecipe, matchUnit, type MappedMeal, type MappedRecipe } from "./map.js";

const GUID = mssql.UniqueIdentifier;

export interface Tally {
  created: number;
  /** Already there and changed in Mealie since, so brought up to date. */
  updated: number;
  unchanged: number;
}

export interface ImportReport {
  foods: Tally & { linked: number };
  recipes: Tally;
  mealPlans: Tally;
  /** Everything that couldn't be carried over exactly, one line each. The same on every run. */
  problems: string[];
}

type Kind = "recipe" | "food" | "planned_meal";
type Db = mssql.ConnectionPool | mssql.Transaction;

const request = (db: Db) => (db instanceof mssql.Transaction ? new mssql.Request(db) : db.request());

async function inTransaction<T>(pool: mssql.ConnectionPool, work: (tx: mssql.Transaction) => Promise<T>): Promise<T> {
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  }
}

/**
 * Writes what was read from Mealie into one household: foods, recipes (with tags,
 * ingredients and steps) and meal plan entries. Running it again is safe: each Mealie item is
 * linked to the row it became (`import_source`), an unchanged item is left alone (so edits
 * made in the kitchen app since survive), a changed one is updated and a deleted one is
 * recreated. Nothing is ever deleted. Problems are collected in the report, never thrown,
 * so one bad recipe doesn't stop the rest.
 */
export async function importMealie(pool: mssql.ConnectionPool, householdId: string, data: MealieExport): Promise<ImportReport> {
  const problems = [...data.problems];
  const report: ImportReport = {
    foods: { created: 0, updated: 0, unchanged: 0, linked: 0 },
    recipes: { created: 0, updated: 0, unchanged: 0 },
    mealPlans: { created: 0, updated: 0, unchanged: 0 },
    problems,
  };
  const h = (db: Db) => request(db).input("h", GUID, householdId);

  async function link(db: Db, kind: Kind, externalId: string) {
    const r = await h(db)
      .input("kind", mssql.VarChar(20), kind)
      .input("ext", mssql.NVarChar(200), externalId)
      .query("SELECT local_id, fingerprint FROM import_source WHERE household_id = @h AND source = 'mealie' AND kind = @kind AND external_id = @ext");
    const row = r.recordset[0];
    return row ? { localId: String(row.local_id), fingerprint: row.fingerprint === null ? null : String(row.fingerprint) } : undefined;
  }

  async function saveLink(db: Db, kind: Kind, externalId: string, localId: string, print: string | null) {
    await h(db)
      .input("kind", mssql.VarChar(20), kind)
      .input("ext", mssql.NVarChar(200), externalId)
      .input("local", GUID, localId)
      .input("print", mssql.Char(64), print)
      .query(`
        UPDATE import_source SET local_id = @local, fingerprint = @print, imported_at = SYSUTCDATETIME()
        WHERE household_id = @h AND source = 'mealie' AND kind = @kind AND external_id = @ext;
        IF @@ROWCOUNT = 0
          INSERT import_source (household_id, source, kind, external_id, local_id, fingerprint)
          VALUES (@h, 'mealie', @kind, @ext, @local, @print);`);
  }

  const exists = async (db: Db, table: "food" | "recipe" | "planned_meal", id: string) =>
    (await h(db).input("id", GUID, id).query(`SELECT 1 AS found FROM ${table} WHERE id = @id AND household_id = @h`)).recordset.length > 0;

  const foodIds = new Map<string, string>();
  /** The household's food with this name (case-insensitive), made if it's new. */
  async function foodId(db: Db, name: string): Promise<{ id: string; created: boolean }> {
    const cached = foodIds.get(name.toLowerCase());
    if (cached) return { id: cached, created: false };
    const found = await h(db).input("name", mssql.NVarChar(200), name).query("SELECT id FROM food WHERE household_id = @h AND name = @name");
    let id = found.recordset[0]?.id as string | undefined;
    let created = false;
    if (!id) {
      const added = await h(db).input("name", mssql.NVarChar(200), name).query("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @name)");
      id = added.recordset[0].id as string;
      created = true;
    }
    foodIds.set(name.toLowerCase(), id);
    return { id, created };
  }

  // 1. Foods
  for (const raw of data.foods) {
    const externalId = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!externalId || !name || name.length > 200) {
      problems.push(`A food (${name || externalId || "no name"}) has no usable name or id and was skipped.`);
      continue;
    }
    try {
      await inTransaction(pool, async (tx) => {
        const known = await link(tx, "food", externalId);
        if (known && (await exists(tx, "food", known.localId))) {
          report.foods.unchanged++;
          return;
        }
        const food = await foodId(tx, name);
        await saveLink(tx, "food", externalId, food.id, null);
        if (food.created) report.foods.created++;
        else report.foods.linked++;
      });
    } catch (error) {
      foodIds.delete(name.toLowerCase());
      problems.push(`Food "${name}" couldn't be imported: ${errorText(error)}`);
    }
  }

  // 2. Recipes
  const unitRows = await pool.request().query("SELECT id, name, abbreviation FROM unit");
  const unitIds = new Map<string, string>();
  for (const u of unitRows.recordset) {
    unitIds.set(String(u.name).toLowerCase(), u.id);
    unitIds.set(String(u.abbreviation).toLowerCase(), u.id);
  }

  const recipeIds = new Map<string, string>(); // Mealie recipe id → new recipe id
  for (const raw of data.recipes) {
    const recipe = mapRecipe(raw, problems);
    if (!recipe) continue;
    // A unit the unit table doesn't have is kept in the ingredient's note instead.
    const ingredients = recipe.ingredients.map((i) => {
      if (i.unit === null) return { ...i, unitId: null as string | null };
      const unitId = matchUnit(unitIds, i.unit);
      if (unitId) return { ...i, unitId };
      problems.push(`Recipe "${recipe.name}": unit "${i.unit}" for ${i.food} isn't a known unit; it was kept in the note.`);
      return { ...i, unitId: null, note: [i.unit, i.note].filter(Boolean).join(", ").slice(0, 500) };
    });
    const print = fingerprint({ ...recipe, mealieId: undefined, ingredients });
    try {
      const id = await inTransaction(pool, async (tx) => {
        const known = await link(tx, "recipe", recipe.mealieId);
        const present = known ? await exists(tx, "recipe", known.localId) : false;
        if (known && present && known.fingerprint === print) {
          report.recipes.unchanged++;
          return known.localId;
        }
        const fields = (r: mssql.Request) =>
          r
            .input("name", mssql.NVarChar(200), recipe.name)
            .input("servings", mssql.Int, recipe.servings)
            .input("minutes", mssql.Int, recipe.totalMinutes)
            .input("url", mssql.NVarChar(2000), recipe.sourceUrl)
            .input("credit", mssql.NVarChar(200), recipe.sourceCredit);
        let localId: string;
        if (known && present) {
          localId = known.localId;
          await fields(h(tx).input("id", GUID, localId)).query(
            `UPDATE recipe SET name = @name, servings = @servings, total_minutes = @minutes, source_url = @url,
               source_credit = @credit, updated_at = SYSUTCDATETIME() WHERE id = @id AND household_id = @h`,
          );
          for (const table of ["recipe_tag", "recipe_ingredient", "recipe_step"]) {
            await request(tx).input("id", GUID, localId).query(`DELETE ${table} WHERE recipe_id = @id`);
          }
          report.recipes.updated++;
        } else {
          const added = await fields(h(tx)).query(
            `INSERT recipe (household_id, name, servings, total_minutes, source_url, source_credit)
             OUTPUT inserted.id VALUES (@h, @name, @servings, @minutes, @url, @credit)`,
          );
          localId = added.recordset[0].id as string;
          report.recipes.created++;
        }
        await writeParts(tx, localId, recipe, ingredients);
        await saveLink(tx, "recipe", recipe.mealieId, localId, print);
        return localId;
      });
      recipeIds.set(recipe.mealieId, id);
    } catch (error) {
      foodIds.clear(); // it may hold foods that the rolled-back transaction made
      problems.push(`Recipe "${recipe.name}" couldn't be imported: ${errorText(error)}`);
    }
  }

  async function writeParts(
    tx: mssql.Transaction,
    recipeId: string,
    recipe: MappedRecipe,
    ingredients: (MappedRecipe["ingredients"][number] & { unitId: string | null })[],
  ) {
    const part = () => h(tx).input("id", GUID, recipeId);
    for (const tag of recipe.tags) {
      await part().input("tag", mssql.NVarChar(50), tag).query("INSERT recipe_tag (recipe_id, tag) VALUES (@id, @tag)");
    }
    for (const [i, ingredient] of ingredients.entries()) {
      const food = await foodId(tx, ingredient.food);
      await part()
        .input("pos", mssql.Int, i + 1)
        .input("food", GUID, food.id)
        .input("qty", mssql.Decimal(12, 4), ingredient.quantity)
        .input("unit", GUID, ingredient.unitId)
        .input("note", mssql.NVarChar(500), ingredient.note)
        .query(
          `INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, unit_id, note)
           VALUES (@id, @h, @pos, @food, @qty, @unit, @note)`,
        );
    }
    for (const [i, instruction] of recipe.steps.entries()) {
      await part()
        .input("pos", mssql.Int, i + 1)
        .input("text", mssql.NVarChar(4000), instruction)
        .query("INSERT recipe_step (recipe_id, position, instruction) VALUES (@id, @pos, @text)");
    }
  }

  // 3. Meal plans. A recipe imported on an earlier run counts too.
  const recipeLocalId = async (mealieRecipeId: string): Promise<string | undefined> => {
    const fresh = recipeIds.get(mealieRecipeId);
    if (fresh) return fresh;
    const known = await link(pool, "recipe", mealieRecipeId);
    return known && (await exists(pool, "recipe", known.localId)) ? known.localId : undefined;
  };

  for (const raw of data.mealPlans) {
    const meal: MappedMeal | null = mapMealPlanEntry(raw, problems);
    if (!meal) continue;
    const recipeId = await recipeLocalId(meal.mealieRecipeId);
    if (!recipeId) {
      problems.push(`Meal plan entry ${meal.date} (${meal.slot}) uses a recipe that wasn't imported, so it was skipped.`);
      continue;
    }
    try {
      await inTransaction(pool, async (tx) => {
        const servings = (await h(tx).input("id", GUID, recipeId).query("SELECT servings FROM recipe WHERE id = @id AND household_id = @h"))
          .recordset[0]?.servings as number | null | undefined;
        const print = fingerprint({ date: meal.date, slot: meal.slot, recipeId: recipeId.toLowerCase() });
        const known = await link(tx, "planned_meal", meal.mealieId);
        const present = known ? await exists(tx, "planned_meal", known.localId) : false;
        if (known && present && known.fingerprint === print) {
          report.mealPlans.unchanged++;
          return;
        }
        const fields = (r: mssql.Request) =>
          r.input("date", mssql.Date, meal.date).input("slot", mssql.VarChar(10), meal.slot).input("recipe", GUID, recipeId);
        if (known && present) {
          // A changed entry starts again from the recipe's servings, like a newly planned meal.
          await fields(h(tx).input("id", GUID, known.localId).input("servings", mssql.Int, servings ?? 1)).query(
            `UPDATE planned_meal SET plan_date = @date, meal_slot = @slot, recipe_id = @recipe, servings = @servings
             WHERE id = @id AND household_id = @h`,
          );
          await saveLink(tx, "planned_meal", meal.mealieId, known.localId, print);
          report.mealPlans.updated++;
        } else {
          const added = await fields(h(tx).input("servings", mssql.Int, servings ?? 1)).query(
            `INSERT planned_meal (household_id, plan_date, meal_slot, recipe_id, servings)
             OUTPUT inserted.id VALUES (@h, @date, @slot, @recipe, @servings)`,
          );
          await saveLink(tx, "planned_meal", meal.mealieId, added.recordset[0].id as string, print);
          report.mealPlans.created++;
        }
      });
    } catch (error) {
      problems.push(`Meal plan entry ${meal.date} (${meal.slot}) couldn't be imported: ${errorText(error)}`);
    }
  }

  return report;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The report as plain lines, for the person running the import. */
export function formatReport(report: ImportReport): string {
  const line = (label: string, t: Tally, extra = "") =>
    `${label}: ${t.created} new, ${t.updated} updated, ${t.unchanged} unchanged${extra}`;
  return [
    line("Foods", report.foods, `, ${report.foods.linked} matched to a food you already had`),
    line("Recipes", report.recipes),
    line("Meal plan", report.mealPlans),
    report.problems.length
      ? `\n${report.problems.length} thing(s) couldn't be carried over exactly:\n${report.problems.map((p) => `  - ${p}`).join("\n")}`
      : "\nNothing was left behind.",
  ].join("\n");
}
