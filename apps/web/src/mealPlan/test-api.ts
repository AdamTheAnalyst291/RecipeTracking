import type { PlannedMeal, RecipeSummary } from "@kitchen/shared";
import { MealPlanApiError, type MealPlanApi } from "./api.js";
import { addDays } from "./dates.js";

/** Made-up recipes for the meal plan tests; the repo is public. */
export const recipeChoices: RecipeSummary[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Lentil soup", servings: 4, totalMinutes: 45, tags: ["soup"] },
  { id: "22222222-2222-4222-8222-222222222222", name: "Flatbread", servings: null, totalMinutes: 20, tags: [] },
];

const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"];

/** A meal plan API held in memory, for the screen tests. */
export function inMemoryMealPlanApi(initial: PlannedMeal[] = []): MealPlanApi & { meals: Map<string, PlannedMeal>; failNextWith?: MealPlanApiError } {
  const meals = new Map(initial.map((m) => [m.id, m]));
  let next = 1;
  const api: ReturnType<typeof inMemoryMealPlanApi> = {
    meals,
    async week(start) {
      const fail = api.failNextWith;
      if (fail) {
        api.failNextWith = undefined;
        throw fail;
      }
      const end = addDays(start, 7);
      return [...meals.values()]
        .filter((m) => m.date >= start && m.date < end)
        .sort((a, b) => a.date.localeCompare(b.date) || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    },
    async add(input) {
      const recipe = recipeChoices.find((r) => r.id === input.recipeId);
      if (!recipe) throw new MealPlanApiError(404, "No such recipe.");
      const meal: PlannedMeal = {
        id: `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
        date: input.date,
        slot: input.slot,
        recipeId: recipe.id,
        recipeName: recipe.name,
        servings: input.servings ?? recipe.servings ?? 1,
      };
      meals.set(meal.id, meal);
      return meal;
    },
    async update(id, change) {
      const meal = meals.get(id);
      if (!meal) throw new MealPlanApiError(404, "No such planned meal.");
      const updated = { ...meal, ...change };
      meals.set(id, updated);
      return updated;
    },
    async remove(id) {
      if (!meals.delete(id)) throw new MealPlanApiError(404, "No such planned meal.");
    },
  };
  return api;
}
