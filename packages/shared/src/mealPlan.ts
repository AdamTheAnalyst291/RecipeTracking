/** The meal slots of a day, in the order the plan shows them. */
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

/** A recipe planned for a day and meal slot. `date` is `YYYY-MM-DD`. */
export interface PlannedMeal {
  id: string;
  date: string;
  slot: MealSlot;
  recipeId: string;
  recipeName: string;
  servings: number;
}

/** Response body of `GET /api/meal-plan?start=YYYY-MM-DD`: the seven days from `start`. */
export interface MealPlanWeekResponse {
  start: string;
  meals: PlannedMeal[];
}

/** Body of `POST /api/meal-plan`. `servings` defaults to the recipe's. */
export interface NewPlannedMeal {
  date: string;
  slot: MealSlot;
  recipeId: string;
  servings?: number;
}

/** Body of `PATCH /api/meal-plan/{id}`: any of these, at least one. Changing `date` or `slot` moves the meal. */
export interface PlannedMealChange {
  date?: string;
  slot?: MealSlot;
  servings?: number;
}
