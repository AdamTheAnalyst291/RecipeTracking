import type { Recipe, RecipeInput, RecipeSummary, Unit } from "@kitchen/shared";
import mssql from "mssql";
import type { SignedInUser } from "../auth.js";

/** The recipe input names something that doesn't exist, like a unit. The message is for the person. */
export class RecipeInputError extends Error {}

/** Where recipes live. Every call acts within the signed-in person's household. */
export interface RecipeStore {
  list(user: SignedInUser): Promise<RecipeSummary[]>;
  get(user: SignedInUser, id: string): Promise<Recipe | null>;
  create(user: SignedInUser, input: RecipeInput): Promise<Recipe>;
  /** Replaces the whole recipe; null when this household has no such recipe. */
  replace(user: SignedInUser, id: string, input: RecipeInput): Promise<Recipe | null>;
  /** False when this household has no such recipe. */
  remove(user: SignedInUser, id: string): Promise<boolean>;
  units(): Promise<Unit[]>;
}

const UNIQUE_VIOLATION = [2601, 2627];

function isUniqueViolation(error: unknown): boolean {
  return error instanceof mssql.RequestError && UNIQUE_VIOLATION.includes(Number(error.number));
}

export function createSqlRecipeStore(pool: mssql.ConnectionPool): RecipeStore {
  /**
   * The database household this person belongs to. The first request from a household member
   * creates the household (or joins them to the one a fellow member already made), so there is
   * no separate sign-up step.
   */
  async function householdId(user: SignedInUser): Promise<string> {
    const find = async (): Promise<string | undefined> => {
      const request = pool.request();
      const placeholders = user.household.memberObjectIds.map((oid, i) => {
        request.input(`m${i}`, mssql.UniqueIdentifier, oid);
        return `@m${i}`;
      });
      const rows = await request.query(
        `SELECT TOP 1 household_id AS id FROM [user] WHERE entra_object_id IN (${placeholders.join(", ")}) ORDER BY created_at`,
      );
      return rows.recordset[0]?.id;
    };

    const found = await find();
    if (found) {
      await addMember(found, user);
      return found;
    }
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      const created = await new mssql.Request(tx).query("INSERT household (name) OUTPUT inserted.id VALUES (N'Home')");
      const id: string = created.recordset[0].id;
      await new mssql.Request(tx)
        .input("h", mssql.UniqueIdentifier, id)
        .input("oid", mssql.UniqueIdentifier, user.objectId)
        .input("name", mssql.NVarChar(200), user.name ?? null)
        .query("INSERT [user] (household_id, entra_object_id, display_name) VALUES (@h, @oid, @name)");
      await tx.commit();
      return id;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      // Two first requests at once: the other one won, so use its household.
      if (isUniqueViolation(error)) {
        const winner = await find();
        if (winner) return winner;
      }
      throw error;
    }
  }

  async function addMember(household: string, user: SignedInUser): Promise<void> {
    try {
      await pool
        .request()
        .input("h", mssql.UniqueIdentifier, household)
        .input("oid", mssql.UniqueIdentifier, user.objectId)
        .input("name", mssql.NVarChar(200), user.name ?? null)
        .query(
          `IF NOT EXISTS (SELECT 1 FROM [user] WHERE entra_object_id = @oid)
             INSERT [user] (household_id, entra_object_id, display_name) VALUES (@h, @oid, @name)`,
        );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const GUID = mssql.UniqueIdentifier;

  async function read(db: mssql.ConnectionPool | mssql.Transaction, household: string, id: string): Promise<Recipe | null> {
    const q = (text: string) =>
      (db instanceof mssql.Transaction ? new mssql.Request(db) : db.request())
        .input("h", GUID, household)
        .input("id", GUID, id)
        .query(text);
    const recipe = await q(
      `SELECT id, name, servings, total_minutes, source_url, source_credit
       FROM recipe WHERE id = @id AND household_id = @h`,
    );
    const row = recipe.recordset[0];
    if (!row) return null;
    // One after another: a transaction's connection runs one request at a time.
    const tags = await q("SELECT tag FROM recipe_tag WHERE recipe_id = @id ORDER BY tag");
    const ingredients = await q(
      `SELECT f.name AS food, i.quantity, u.abbreviation AS unit, i.note
       FROM recipe_ingredient i
       JOIN food f ON f.id = i.food_id
       LEFT JOIN unit u ON u.id = i.unit_id
       WHERE i.recipe_id = @id ORDER BY i.position`,
    );
    const steps = await q("SELECT instruction FROM recipe_step WHERE recipe_id = @id ORDER BY position");
    return {
      id: String(row.id).toLowerCase(),
      name: row.name,
      servings: row.servings,
      totalMinutes: row.total_minutes,
      sourceUrl: row.source_url,
      sourceCredit: row.source_credit,
      tags: tags.recordset.map((t) => t.tag),
      ingredients: ingredients.recordset.map((i) => ({
        food: i.food,
        quantity: i.quantity === null ? null : Number(i.quantity),
        unit: i.unit,
        note: i.note,
      })),
      steps: steps.recordset.map((s) => s.instruction),
    };
  }

  /** Writes a recipe's tags, ingredients and steps. Throws RecipeInputError for an unknown unit. */
  async function writeParts(tx: mssql.Transaction, household: string, id: string, input: RecipeInput): Promise<void> {
    const req = () => new mssql.Request(tx).input("h", GUID, household).input("id", GUID, id);

    const unitRows = await new mssql.Request(tx).query("SELECT id, name, abbreviation FROM unit");
    const unitIds = new Map<string, string>();
    for (const u of unitRows.recordset) {
      unitIds.set(String(u.name).toLowerCase(), u.id);
      unitIds.set(String(u.abbreviation).toLowerCase(), u.id);
    }

    for (const tag of input.tags) {
      await req().input("tag", mssql.NVarChar(50), tag).query("INSERT recipe_tag (recipe_id, tag) VALUES (@id, @tag)");
    }

    for (const [i, ingredient] of input.ingredients.entries()) {
      let unitId: string | null = null;
      if (ingredient.unit !== null) {
        unitId = unitIds.get(ingredient.unit.toLowerCase()) ?? null;
        if (unitId === null) throw new RecipeInputError(`Ingredient ${i + 1}'s unit "${ingredient.unit}" isn't a known unit.`);
      }
      const existing = await req().input("name", mssql.NVarChar(200), ingredient.food).query(
        "SELECT id FROM food WHERE household_id = @h AND name = @name",
      );
      let foodId: string | undefined = existing.recordset[0]?.id;
      if (!foodId) {
        const added = await req()
          .input("name", mssql.NVarChar(200), ingredient.food)
          .query("INSERT food (household_id, name) OUTPUT inserted.id VALUES (@h, @name)");
        foodId = added.recordset[0].id as string;
      }
      await req()
        .input("pos", mssql.Int, i + 1)
        .input("food", GUID, foodId)
        .input("qty", mssql.Decimal(12, 4), ingredient.quantity)
        .input("unit", GUID, unitId)
        .input("note", mssql.NVarChar(500), ingredient.note)
        .query(
          `INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, unit_id, note)
           VALUES (@id, @h, @pos, @food, @qty, @unit, @note)`,
        );
    }

    for (const [i, instruction] of input.steps.entries()) {
      await req()
        .input("pos", mssql.Int, i + 1)
        .input("text", mssql.NVarChar(4000), instruction)
        .query("INSERT recipe_step (recipe_id, position, instruction) VALUES (@id, @pos, @text)");
    }
  }

  async function inTransaction<T>(work: (tx: mssql.Transaction) => Promise<T>): Promise<T> {
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

  const fields = (request: mssql.Request, input: RecipeInput) =>
    request
      .input("name", mssql.NVarChar(200), input.name)
      .input("servings", mssql.Int, input.servings)
      .input("minutes", mssql.Int, input.totalMinutes)
      .input("url", mssql.NVarChar(2000), input.sourceUrl)
      .input("credit", mssql.NVarChar(200), input.sourceCredit);

  return {
    async list(user) {
      const household = await householdId(user);
      const rows = await pool.request().input("h", GUID, household).query(
        `SELECT r.id, r.name, r.servings, r.total_minutes, t.tag
         FROM recipe r LEFT JOIN recipe_tag t ON t.recipe_id = r.id
         WHERE r.household_id = @h
         ORDER BY r.name, r.id, t.tag`,
      );
      const byId = new Map<string, RecipeSummary>();
      for (const row of rows.recordset) {
        const id = String(row.id).toLowerCase();
        let summary = byId.get(id);
        if (!summary) {
          summary = { id, name: row.name, servings: row.servings, totalMinutes: row.total_minutes, tags: [] };
          byId.set(id, summary);
        }
        if (row.tag !== null) summary.tags.push(row.tag);
      }
      return [...byId.values()];
    },

    async get(user, id) {
      return read(pool, await householdId(user), id);
    },

    async create(user, input) {
      const household = await householdId(user);
      return inTransaction(async (tx) => {
        const created = await fields(new mssql.Request(tx).input("h", GUID, household), input).query(
          `INSERT recipe (household_id, name, servings, total_minutes, source_url, source_credit)
           OUTPUT inserted.id
           VALUES (@h, @name, @servings, @minutes, @url, @credit)`,
        );
        const id = String(created.recordset[0].id);
        await writeParts(tx, household, id, input);
        const saved = await read(tx, household, id);
        if (!saved) throw new Error("A recipe just inserted was not found");
        return saved;
      });
    },

    async replace(user, id, input) {
      const household = await householdId(user);
      return inTransaction(async (tx) => {
        const updated = await fields(new mssql.Request(tx).input("h", GUID, household).input("id", GUID, id), input).query(
          `UPDATE recipe
           SET name = @name, servings = @servings, total_minutes = @minutes, source_url = @url,
               source_credit = @credit, updated_at = SYSUTCDATETIME()
           WHERE id = @id AND household_id = @h`,
        );
        if (updated.rowsAffected[0] === 0) return null;
        for (const table of ["recipe_tag", "recipe_ingredient", "recipe_step"]) {
          await new mssql.Request(tx).input("id", GUID, id).query(`DELETE ${table} WHERE recipe_id = @id`);
        }
        await writeParts(tx, household, id, input);
        return read(tx, household, id);
      });
    },

    async remove(user, id) {
      const household = await householdId(user);
      const deleted = await pool.request().input("h", GUID, household).input("id", GUID, id).query(
        "DELETE recipe WHERE id = @id AND household_id = @h",
      );
      return (deleted.rowsAffected[0] ?? 0) > 0;
    },

    async units() {
      const rows = await pool.request().query("SELECT name, abbreviation FROM unit ORDER BY kind, name");
      return rows.recordset.map((u) => ({ name: u.name, abbreviation: u.abbreviation }));
    },
  };
}
