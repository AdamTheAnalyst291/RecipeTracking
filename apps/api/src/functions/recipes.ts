import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { parseRecipeInput, type RecipeListResponse, type UnitListResponse } from "@kitchen/shared";
import type { AuthenticatedHandler } from "../auth.js";
import { RecipeInputError, type RecipeStore } from "../recipes/store.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound: HttpResponseInit = { status: 404, jsonBody: { error: "No such recipe." } };
const methodNotAllowed: HttpResponseInit = { status: 405, jsonBody: { error: "Method not allowed." } };

async function readRecipe(request: HttpRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: { status: 400, jsonBody: { error: "The body must be JSON.", errors: ["The body must be JSON."] } } };
  }
  const parsed = parseRecipeInput(body);
  if (!parsed.ok) {
    return { response: { status: 400, jsonBody: { error: "The recipe isn't valid.", errors: parsed.errors } } };
  }
  return { input: parsed.value };
}

/**
 * The recipe routes: `/recipes` (list, create), `/recipes/{id}` (read, edit, delete) and `/units`.
 * The store is looked up per request, so a missing database setting fails one request with 500
 * rather than the whole app at start-up.
 */
export function createRecipeHandlers(getStore: () => RecipeStore | Promise<RecipeStore>): {
  collection: AuthenticatedHandler;
  item: AuthenticatedHandler;
  units: AuthenticatedHandler;
} {
  const guarded =
    (handle: (store: RecipeStore, request: HttpRequest, user: Parameters<AuthenticatedHandler>[2]) => Promise<HttpResponseInit>): AuthenticatedHandler =>
    async (request, _context, user) => {
      try {
        return await handle(await getStore(), request, user);
      } catch (error) {
        if (error instanceof RecipeInputError) {
          return { status: 400, jsonBody: { error: "The recipe isn't valid.", errors: [error.message] } };
        }
        console.error("Recipe request failed", error);
        return { status: 500, jsonBody: { error: "Something went wrong on our side." } };
      }
    };

  return {
    collection: guarded(async (store, request, user) => {
      if (request.method === "GET") {
        const body: RecipeListResponse = { recipes: await store.list(user) };
        return { status: 200, jsonBody: body };
      }
      if (request.method === "POST") {
        const read = await readRecipe(request);
        if (!read.input) return read.response;
        const recipe = await store.create(user, read.input);
        return { status: 201, headers: { Location: `/api/recipes/${recipe.id}` }, jsonBody: recipe };
      }
      return methodNotAllowed;
    }),

    item: guarded(async (store, request, user) => {
      const id = request.params.id ?? "";
      if (!GUID.test(id)) return notFound;
      switch (request.method) {
        case "GET": {
          const recipe = await store.get(user, id);
          return recipe ? { status: 200, jsonBody: recipe } : notFound;
        }
        case "PUT": {
          const read = await readRecipe(request);
          if (!read.input) return read.response;
          const recipe = await store.replace(user, id, read.input);
          return recipe ? { status: 200, jsonBody: recipe } : notFound;
        }
        case "DELETE":
          return (await store.remove(user, id)) ? { status: 204 } : notFound;
        default:
          return methodNotAllowed;
      }
    }),

    units: guarded(async (store) => {
      const body: UnitListResponse = { units: await store.units() };
      return { status: 200, jsonBody: body };
    }),
  };
}
