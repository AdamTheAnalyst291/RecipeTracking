/** One line on a shopping list. `quantity` and the unit are null for a line with no amount. */
export interface ShoppingItem {
  id: string;
  foodId: string | null;
  name: string;
  quantity: number | null;
  /** Such as `g`. */
  unit: string | null;
  unitId: string | null;
  /** `plan`: worked out from the meal plan. `manual`: added by hand. */
  source: "plan" | "manual";
  checked: boolean;
}

/** A list built for the days `start` to `end` inclusive (`YYYY-MM-DD`). `createdAt` is ISO 8601, UTC. */
export interface ShoppingList {
  id: string;
  start: string;
  end: string;
  createdAt: string;
  items: ShoppingItem[];
}

/** Response body of `GET /api/shopping-list`: the most recent list, or null before the first one is made. */
export interface ShoppingListResponse {
  list: ShoppingList | null;
}

/** Body of `POST /api/shopping-list`. Both dates default to the coming week: today and the six days after (UTC). */
export interface NewShoppingList {
  start?: string;
  end?: string;
}

/** Body of `POST /api/shopping-list/{id}/items`: something added by hand. A unit needs an amount. */
export interface NewShoppingItem {
  name: string;
  quantity?: number;
  unitId?: string;
}
