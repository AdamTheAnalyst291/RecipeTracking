/** Response body of the API's health endpoint, shared by the API and the web app. */
export interface HealthResponse {
  status: "ok";
}

/** Response body of `GET /api/me`: who is signed in and their household. */
export interface MeResponse {
  name: string | null;
  household: { id: string };
}

export * from "./recipes.js";
/** A pantry product: something bought or kept, tied to a food. Dates are `YYYY-MM-DD`. */
export interface PantryProduct {
  id: string;
  foodId: string;
  name: string;
  /** The unit stock and package size are counted in, such as `g`. */
  unit: string;
  unitId: string;
  stockQuantity: number;
  /** Only staples are tracked; a food with no staple product counts as "assume we need it". */
  staple: boolean;
  /** The size the latest price is for, in `unit`. */
  packageQuantity: number | null;
  priceCents: number | null;
  priceDate: string | null;
}

/** Response body of `GET /api/pantry/products`. */
export interface PantryResponse {
  products: PantryProduct[];
}

/** Body of `POST /api/pantry/products`. `name` defaults to the food's name. */
export interface NewPantryProduct {
  foodId: string;
  unitId: string;
  name?: string;
  staple?: boolean;
  stockQuantity?: number;
}

/** Body of `PATCH /api/pantry/products/{id}`: any of these, at least one. `set` makes stock exact; `delta` adds or takes away. */
export interface PantryProductChange {
  stock?: { set: number } | { delta: number };
  staple?: boolean;
  price?: { priceCents: number; packageQuantity: number; date: string };
}

/** Error body of the pantry routes. */
export interface ApiError {
  error: string;
}
