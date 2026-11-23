import type { HttpHandler, HttpMethod } from "@azure/functions";
import { withAuth, type AuthenticatedHandler } from "./auth.js";
import { health } from "./functions/health.js";
import { meHandler } from "./functions/me.js";
import { createRecipeHandlers, sqlStoreFromEnv } from "./functions/recipes.js";

const recipes = createRecipeHandlers(() => sqlStoreFromEnv());

interface RouteBase {
  name: string;
  route: string;
  methods: HttpMethod[];
}

/**
 * Every API function. A household route is wrapped in the sign-in check here, so a new
 * function can't forget it; `public` is for the health check only (routes.test.ts holds that).
 */
type RouteSpec =
  | (RouteBase & { access: "public"; handler: HttpHandler })
  | (RouteBase & { access: "household"; handler: AuthenticatedHandler });

const specs: RouteSpec[] = [
  { name: "health", route: "health", methods: ["GET"], access: "public", handler: health },
  { name: "me", route: "me", methods: ["GET"], access: "household", handler: meHandler },
  { name: "recipes", route: "recipes", methods: ["GET", "POST"], access: "household", handler: recipes.collection },
  { name: "recipe", route: "recipes/{id}", methods: ["GET", "PUT", "DELETE"], access: "household", handler: recipes.item },
  { name: "units", route: "units", methods: ["GET"], access: "household", handler: recipes.units },
];

export const routes: (RouteBase & { access: RouteSpec["access"]; handler: HttpHandler })[] = specs.map((spec) =>
  spec.access === "public" ? spec : { ...spec, handler: withAuth(spec.handler) },
);
