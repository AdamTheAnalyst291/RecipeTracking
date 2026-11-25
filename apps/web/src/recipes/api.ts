import type { CookedRequest, CookedResponse, Recipe, RecipeImportRequest, RecipeImportResponse, RecipeInput, RecipeListResponse, RecipeSummary, Unit, UnitListResponse } from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the screens need from the recipe API; tests swap in an in-memory one. */
export interface RecipeApi {
  list(): Promise<RecipeSummary[]>;
  get(id: string): Promise<Recipe>;
  create(input: RecipeInput): Promise<Recipe>;
  update(id: string, input: RecipeInput): Promise<Recipe>;
  remove(id: string): Promise<void>;
  units(): Promise<Unit[]>;
  /** Reads the recipe on a web page into a draft; nothing is saved until `create`. */
  importFromUrl(url: string): Promise<RecipeImportResponse>;
  /** "I made this": uses up pantry stock for the servings made and logs the cook. */
  cooked(id: string, servingsMade?: number): Promise<CookedResponse>;
}

/** A request the API refused or couldn't answer. `messages` are fit to show the person. */
export class RecipeApiError extends Error {
  constructor(
    readonly status: number,
    readonly messages: string[],
  ) {
    super(messages.join(" "));
  }
}

export function createRecipeApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): RecipeApi {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined
          ? { method, headers: auth }
          : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}${path}`, init);
    } catch (error) {
      throw new RecipeApiError(0, [error instanceof Error ? error.message : "Request failed"]);
    }
    if (response.ok) return response;
    let messages = [`HTTP ${response.status}`];
    try {
      const problem = (await response.json()) as { errors?: unknown };
      if (Array.isArray(problem.errors) && problem.errors.every((e) => typeof e === "string") && problem.errors.length > 0) {
        messages = problem.errors as string[];
      }
    } catch {
      // not JSON: keep the status
    }
    throw new RecipeApiError(response.status, messages);
  }

  return {
    async list() {
      return ((await (await send("GET", "/api/recipes")).json()) as RecipeListResponse).recipes;
    },
    async get(id) {
      return (await (await send("GET", `/api/recipes/${id}`)).json()) as Recipe;
    },
    async create(input) {
      return (await (await send("POST", "/api/recipes", input)).json()) as Recipe;
    },
    async update(id, input) {
      return (await (await send("PUT", `/api/recipes/${id}`, input)).json()) as Recipe;
    },
    async remove(id) {
      await send("DELETE", `/api/recipes/${id}`);
    },
    async importFromUrl(url) {
      const body: RecipeImportRequest = { url };
      return (await (await send("POST", "/api/recipe-import", body)).json()) as RecipeImportResponse;
    },
    async units() {
      return ((await (await send("GET", "/api/units")).json()) as UnitListResponse).units;
    },
    async cooked(id, servingsMade) {
      const body: CookedRequest = servingsMade === undefined ? {} : { servingsMade };
      return (await (await send("POST", `/api/recipes/${id}/cooked`, body)).json()) as CookedResponse;
    },
  };
}
