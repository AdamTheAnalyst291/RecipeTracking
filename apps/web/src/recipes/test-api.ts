import type { Recipe, RecipeInput, Unit } from "@kitchen/shared";
import { RecipeApiError, type RecipeApi } from "./api.js";

/** Made-up recipes for the screen tests; the repo is public. */
export const lentilSoup: Recipe = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Lentil soup",
  servings: 4,
  totalMinutes: 45,
  sourceUrl: "https://example.com/lentil-soup",
  sourceCredit: "Made-up Cookbook",
  tags: ["quick", "soup"],
  ingredients: [
    { food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" },
    { food: "Salt", quantity: null, unit: null, note: null },
  ],
  steps: ["Simmer the lentils.", "Season and serve."],
};

export const flatbread: Recipe = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Flatbread",
  servings: null,
  totalMinutes: 20,
  sourceUrl: null,
  sourceCredit: null,
  tags: ["bread"],
  ingredients: [{ food: "Flour", quantity: 250, unit: "g", note: null }],
  steps: ["Mix.", "Fry."],
};

export const units: Unit[] = [
  { name: "gram", abbreviation: "g" },
  { name: "cup", abbreviation: "cup" },
  { name: "teaspoon", abbreviation: "tsp" },
];

/** A recipe API held in memory, for the screen tests. */
export function inMemoryRecipeApi(initial: Recipe[] = [lentilSoup, flatbread]): RecipeApi & {
  recipes: Map<string, Recipe>;
  failNextWith?: RecipeApiError;
} {
  const recipes = new Map(initial.map((r) => [r.id, r]));
  let next = 1;
  const api: ReturnType<typeof inMemoryRecipeApi> = {
    recipes,
    async list() {
      const fail = api.failNextWith;
      if (fail) {
        api.failNextWith = undefined;
        throw fail;
      }
      return [...recipes.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ id, name, servings, totalMinutes, tags }) => ({ id, name, servings, totalMinutes, tags }));
    },
    async get(id) {
      const recipe = recipes.get(id);
      if (!recipe) throw new RecipeApiError(404, ["HTTP 404"]);
      return recipe;
    },
    async create(input: RecipeInput) {
      const fail = api.failNextWith;
      if (fail) {
        api.failNextWith = undefined;
        throw fail;
      }
      const recipe = { ...input, id: `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` };
      recipes.set(recipe.id, recipe);
      return recipe;
    },
    async update(id, input) {
      if (!recipes.has(id)) throw new RecipeApiError(404, ["HTTP 404"]);
      const recipe = { ...input, id };
      recipes.set(id, recipe);
      return recipe;
    },
    async remove(id) {
      if (!recipes.delete(id)) throw new RecipeApiError(404, ["HTTP 404"]);
    },
    async units() {
      return units;
    },
  };
  return api;
}
