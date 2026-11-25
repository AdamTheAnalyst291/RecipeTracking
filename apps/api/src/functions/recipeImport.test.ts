import { readFileSync } from "node:fs";
import { HttpRequest, InvocationContext, type HttpResponseInit } from "@azure/functions";
import type { RecipeImportResponse } from "@kitchen/shared";
import { describe, expect, it, vi } from "vitest";
import { withAuth } from "../auth.js";
import { createPageFetcher, PageFetchError, type FetchPage } from "../recipes/import/fetchPage.js";
import { SOMEONE_ELSE, testAuthenticator, token } from "../test/identity.js";
import { createRecipeImportHandler } from "./recipeImport.js";

const page = (name: string) => readFileSync(new URL(`../test/pages/${name}.html`, import.meta.url), "utf8");

const store = {
  units: async () => [{ name: "cup", abbreviation: "cup" }],
  foods: async () => ["Red lentils"],
};

/** A website that serves one saved page; no network involved. */
const serving =
  (name: string): FetchPage =>
  async (url) => ({ url, html: page(name) });

async function post(fetchPage: FetchPage, body: unknown, authorization?: string): Promise<HttpResponseInit> {
  const handler = withAuth(createRecipeImportHandler(() => store, fetchPage), () => testAuthenticator);
  return handler(
    new HttpRequest({
      method: "POST",
      url: "http://localhost:7071/api/recipe-import",
      headers: { authorization: authorization ?? `Bearer ${await token()}` },
      body: { string: typeof body === "string" ? body : JSON.stringify(body) },
    }),
    new InvocationContext(),
  );
}

const url = "https://recipes.example/lentil-stew";
const errorOf = (response: HttpResponseInit) => (response.jsonBody as { errors: string[] }).errors[0];

describe("importing a recipe from a website", () => {
  it("answers with a draft to review", async () => {
    const response = await post(serving("plain-recipe"), { url });

    expect(response.status).toBe(200);
    const body = response.jsonBody as RecipeImportResponse;
    expect(body.recipe).toMatchObject({ name: "Weeknight Lentil Stew", sourceUrl: url });
    expect(body.recipe.ingredients[0]).toEqual({ food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" });
    expect(body.newFoods).not.toContain("Red lentils");
  });

  it.each([
    ["no-recipe", "no recipe data found"],
    ["malformed-recipe", "recipe data is broken"],
  ])("says why a page (%s) can't be imported", async (name, words) => {
    const response = await post(serving(name), { url });

    expect(response.status).toBe(422);
    expect(errorOf(response)?.toLowerCase()).toContain(words);
  });

  it.each([{}, { url: 5 }, { url: "   " }, { url: `https://recipes.example/${"a".repeat(3000)}` }, "not json", "null"])(
    "refuses a request without a usable address (%j)",
    async (body) => {
      expect((await post(serving("plain-recipe"), body)).status).toBe(400);
    },
  );

  it("refuses a private address without fetching it", async () => {
    const response = await post(createPageFetcher(), { url: "http://169.254.169.254/metadata/identity" });

    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain("isn't a public website");
  });

  it.each([
    ["too_large", 422],
    ["timeout", 502],
    ["http_error", 502],
  ] as const)("passes on a fetch failure (%s) with the reason", async (code, status) => {
    const response = await post(async () => Promise.reject(new PageFetchError(code, "Because.")), { url });

    expect(response.status).toBe(status);
    expect(errorOf(response)).toBe("Because.");
  });

  it("keeps an unexpected failure's details to the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await post(async () => Promise.reject(new Error("secret internals")), { url });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("secret");
    log.mockRestore();
  });

  it("is for household members only", async () => {
    const fetchPage = vi.fn(serving("plain-recipe"));

    const response = await post(fetchPage, { url }, `Bearer ${await token({ oid: SOMEONE_ELSE })}`);

    expect(response.status).toBe(403);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
