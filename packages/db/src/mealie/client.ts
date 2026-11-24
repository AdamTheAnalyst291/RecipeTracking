/** What the importer needs from Mealie: read-only. There is deliberately no way to send anything else. */
export interface MealieReader {
  /** GET a path under the Mealie URL, such as `/api/foods?page=1`. Throws MealieHttpError on a non-2xx answer. */
  get(path: string): Promise<unknown>;
}

export class MealieHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Mealie answered ${status} for ${path}`);
    this.name = "MealieHttpError";
  }
}

export interface MealieClientOptions {
  /** Where Mealie lives, like http://localhost:9925 (no trailing path needed). */
  baseUrl: string;
  /** A Mealie API token (Mealie → your profile → API Tokens). */
  token: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * A Mealie client that only ever sends GET: the request method is fixed here and is not a
 * parameter, so reading Mealie cannot change anything in it (ADR-25, card K3).
 */
export function createMealieClient({ baseUrl, token, fetch: doFetch = fetch }: MealieClientOptions): MealieReader {
  const root = new URL(baseUrl);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("MEALIE_URL must start with http:// or https://");
  return {
    async get(path) {
      if (!path.startsWith("/")) throw new Error(`Mealie path must start with /: ${path}`);
      const response = await doFetch(new URL(path, root).toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) throw new MealieHttpError(response.status, path);
      return response.json();
    },
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Everything read from Mealie, plus what couldn't be read. Recipes and entries are raw Mealie JSON. */
export interface MealieExport {
  foods: Json[];
  recipes: Json[];
  mealPlans: Json[];
  /** Things that could not be read (a recipe that errors, say). The import reports them. */
  problems: string[];
}

/** Every item of a paged Mealie list (`{ items, total_pages }`), or a bare array. */
async function getAll(reader: MealieReader, path: string): Promise<Json[]> {
  const items: Json[] = [];
  for (let page = 1; ; page++) {
    const body = await reader.get(`${path}${path.includes("?") ? "&" : "?"}page=${page}&perPage=100`);
    if (Array.isArray(body)) return body.filter(isObject);
    if (!isObject(body) || !Array.isArray(body.items)) throw new Error(`Unexpected answer from Mealie for ${path}`);
    items.push(...body.items.filter(isObject));
    const totalPages = typeof body.total_pages === "number" ? body.total_pages : 1;
    if (page >= totalPages || body.items.length === 0) return items;
  }
}

/** Reads all foods, recipes (full detail) and meal plan entries. Newer and older Mealie paths are both tried for meal plans. */
export async function readMealie(reader: MealieReader): Promise<MealieExport> {
  const problems: string[] = [];
  const foods = await getAll(reader, "/api/foods");

  const summaries = await getAll(reader, "/api/recipes");
  const recipes: Json[] = [];
  for (const summary of summaries) {
    const slug = typeof summary.slug === "string" ? summary.slug : undefined;
    const label = String(summary.name ?? slug ?? summary.id ?? "unknown");
    if (!slug) {
      problems.push(`Recipe "${label}" has no slug, so it can't be read.`);
      continue;
    }
    try {
      const detail = await reader.get(`/api/recipes/${encodeURIComponent(slug)}`);
      if (!isObject(detail)) throw new Error("not a recipe");
      recipes.push(detail);
    } catch (error) {
      problems.push(`Recipe "${label}" couldn't be read: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  let mealPlans: Json[];
  try {
    mealPlans = await getAll(reader, "/api/households/mealplans");
  } catch (error) {
    if (!(error instanceof MealieHttpError) || error.status !== 404) throw error;
    mealPlans = await getAll(reader, "/api/groups/mealplans"); // Mealie before v2
  }
  return { foods, recipes, mealPlans, problems };
}
