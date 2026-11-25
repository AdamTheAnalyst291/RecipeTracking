import type { HttpResponseInit } from "@azure/functions";
import type { RecipeImportResponse } from "@kitchen/shared";
import type { AuthenticatedHandler } from "../auth.js";
import { PageFetchError, type FetchErrorCode, type FetchPage } from "../recipes/import/fetchPage.js";
import { readRecipePage, type ReadPage } from "../recipes/import/recipePage.js";
import type { RecipeStore } from "../recipes/store.js";

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

/**
 * `POST /recipe-import` with `{ url }`: reads the recipe on that web page into a draft for the
 * person to check. Nothing is saved; saving is the ordinary `POST /recipes`.
 */
export function createRecipeImportHandler(
  getStore: () => Pick<RecipeStore, "units" | "foods"> | Promise<Pick<RecipeStore, "units" | "foods">>,
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
    if (url === "" || url.length > 2000) return refuse(400, "Paste the recipe page's web address.");

    try {
      const page = await fetchPage(url);
      const store = await getStore();
      const read = readRecipePage(page.html, page.url, { units: await store.units(), foods: await store.foods(user) });
      if (!read.ok) return refuse(422, REASONS[read.reason]);
      const draft: RecipeImportResponse = { recipe: read.recipe, newFoods: read.newFoods };
      return { status: 200, jsonBody: draft };
    } catch (error) {
      if (error instanceof PageFetchError) return refuse(STATUS[error.code], error.message);
      console.error("Recipe import failed", error);
      return refuse(500, "Something went wrong on our side.");
    }
  };
}
