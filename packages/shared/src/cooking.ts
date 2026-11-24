/** Body of `POST /api/recipes/{id}/cooked` ("I made this"). `servingsMade` defaults to the recipe's own servings. */
export interface CookedRequest {
  servingsMade?: number;
}

/** What "I made this" did to the pantry and what it recorded. */
export interface CookedResponse {
  eventId: string;
  recipeId: string;
  servingsMade: number;
  /** ISO 8601, UTC. */
  cookedAt: string;
  /** Pantry products that were drawn down, in each product's own unit. */
  used: { product: string; amount: number; unit: string }[];
  /** Foods the pantry didn't have enough of, in the recipe's unit. Stock stopped at 0. */
  shortfalls: { food: string; amount: number; unit: string }[];
}
