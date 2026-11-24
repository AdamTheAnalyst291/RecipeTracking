import type { Recipe, RecipeInput } from "@kitchen/shared";
import { describe, expect, it, vi } from "vitest";
import { createRecipeApi, RecipeApiError } from "./api.js";

const api = "https://api.example.net";
const getToken = () => Promise.resolve("token-123");
const input: RecipeInput = {
  name: "Toast",
  servings: 1,
  totalMinutes: 5,
  sourceUrl: null,
  sourceCredit: null,
  tags: [],
  ingredients: [],
  steps: ["Toast."],
};
const recipe: Recipe = { ...input, id: "11111111-1111-4111-8111-111111111111" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const headers = { Authorization: "Bearer token-123" };

describe("recipe API client", () => {
  it("lists recipes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ recipes: [{ id: recipe.id, name: "Toast", servings: 1, totalMinutes: 5, tags: [] }] }));

    const recipes = await createRecipeApi(api, getToken, fetchFn).list();

    expect(recipes).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledWith(`${api}/api/recipes`, { method: "GET", headers });
  });

  it("reads, creates, edits and deletes with the access token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(recipe))
      .mockResolvedValueOnce(json(recipe, 201))
      .mockResolvedValueOnce(json(recipe))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createRecipeApi(api, getToken, fetchFn);

    await expect(client.get(recipe.id)).resolves.toEqual(recipe);
    await expect(client.create(input)).resolves.toEqual(recipe);
    await expect(client.update(recipe.id, input)).resolves.toEqual(recipe);
    await expect(client.remove(recipe.id)).resolves.toBeUndefined();

    const body = JSON.stringify(input);
    const jsonHeaders = { ...headers, "Content-Type": "application/json" };
    expect(fetchFn).toHaveBeenNthCalledWith(1, `${api}/api/recipes/${recipe.id}`, { method: "GET", headers });
    expect(fetchFn).toHaveBeenNthCalledWith(2, `${api}/api/recipes`, { method: "POST", headers: jsonHeaders, body });
    expect(fetchFn).toHaveBeenNthCalledWith(3, `${api}/api/recipes/${recipe.id}`, { method: "PUT", headers: jsonHeaders, body });
    expect(fetchFn).toHaveBeenNthCalledWith(4, `${api}/api/recipes/${recipe.id}`, { method: "DELETE", headers });
  });

  it("carries the API's list of problems on a 400", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: "The recipe isn't valid.", errors: ["Name is required."] }, 400));

    await expect(createRecipeApi(api, getToken, fetchFn).create(input)).rejects.toMatchObject({
      status: 400,
      messages: ["Name is required."],
    });
  });

  it("names the status for anything else, and for a network failure", async () => {
    const down = vi.fn().mockResolvedValue(json({}, 500));
    await expect(createRecipeApi(api, getToken, down).list()).rejects.toEqual(expect.any(RecipeApiError));
    await expect(createRecipeApi(api, getToken, down).list()).rejects.toMatchObject({ status: 500, messages: ["HTTP 500"] });

    const offline = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(createRecipeApi(api, getToken, offline).list()).rejects.toMatchObject({ status: 0, messages: ["Failed to fetch"] });
  });

  it("posts \"I made this\" with the servings made", async () => {
    const result = { eventId: "e", recipeId: recipe.id, servingsMade: 2, cookedAt: "2026-11-22T12:00:00.000Z", used: [], shortfalls: [] };
    const fetchFn = vi.fn().mockResolvedValue(json(result));

    await expect(createRecipeApi(api, getToken, fetchFn).cooked(recipe.id, 2)).resolves.toEqual(result);

    expect(fetchFn).toHaveBeenCalledWith(`${api}/api/recipes/${recipe.id}/cooked`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ servingsMade: 2 }),
    });
  });
});
