import type { MealSlot } from "@kitchen/shared";

export const SLOT_LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };
export const servingsText = (n: number) => `${n} serving${n === 1 ? "" : "s"}`;
export const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");
