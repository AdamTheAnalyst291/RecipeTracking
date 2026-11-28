import type { HttpResponseInit } from "@azure/functions";
import { RECIPE_LIMITS, type RecipeImportResponse } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";
import { PageFetchError, type FetchErrorCode, type FetchPage } from "../recipes/import/fetchPage.js";
import { readRecipePage, type ReadPage } from "../recipes/import/recipePage.js";
import type { RecipeStore } from "../recipes/store.js";

/** The part of the recipe store that matching a page's ingredients needs. */
type Matchable = Pick<RecipeStore, "units" | "foods">;

const STATUS: Record<FetchErrorCode, number> = {
  invalid_url: 400,
  blocked: 400,
  too_large: 422,
  not_html: 422,
  unreachable: 502,
  timeout: 502,
  http_error: 502,
};

const REASONS: Record<Extract<ReadPage, { ok: false }>["reason"], string> = {
  none: "No recipe data found on that page. Add the recipe by hand instead.",
  broken: "That page's recipe data is broken and couldn't be read. Add the recipe by hand instead.",
  incomplete: "That page's recipe data has no name, so it couldn't be imported. Add the recipe by hand instead.",
};

const refuse = (status: number, message: string): HttpResponseInit => ({ status, jsonBody: { error: message, errors: [message] } });

export type ImportedPage = { ok: true; draft: RecipeImportResponse } | { ok: false; status: number; message: string };

/**
 * Fetches a recipe page (fetchPage is the guard on where it may go) and reads it into a draft
 * matched to the household's foods and units. Nothing is saved.
 */
export async function importRecipePage(
  url: string,
  user: SignedInUser,
  getStore: () => Matchable | Promise<Matchable>,
  fetchPage: FetchPage,
): Promise<ImportedPage> {
  try {
    const page = await fetchPage(url);
    const store = await getStore();
    const read = readRecipePage(page.html, page.url, { units: await store.units(), foods: await store.foods(user) });
    if (!read.ok) return { ok: false, status: 422, message: REASONS[read.reason] };
    return { ok: true, draft: { recipe: read.recipe, newFoods: read.newFoods } };
  } catch (error) {
    if (error instanceof PageFetchError) return { ok: false, status: STATUS[error.code], message: error.message };
    throw error;
  }
}

/**
 * `POST /recipe-import` with `{ url }`: reads the recipe on that web page into a draft for the
 * person to check. Nothing is saved; saving is the ordinary `POST /recipes`.
 */
export function createRecipeImportHandler(
  getStore: () => Matchable | Promise<Matchable>,
  fetchPage: FetchPage,
): AuthenticatedHandler {
  return async (request, _context, user) => {
    let url = "";
    try {
      const body = (await request.json()) as { url?: unknown } | null;
      if (typeof body?.url === "string") url = body.url.trim();
    } catch {
      // not JSON: handled below
    }
    if (url === "" || url.length > RECIPE_LIMITS.url) return refuse(400, "Paste the recipe page's web address.");

    try {
      const imported = await importRecipePage(url, user, getStore, fetchPage);
      if (!imported.ok) return refuse(imported.status, imported.message);
      return { status: 200, jsonBody: imported.draft };
    } catch (error) {
      console.error("Recipe import failed", error);
      return refuse(500, "Something went wrong on our side.");
    }
  };
}
