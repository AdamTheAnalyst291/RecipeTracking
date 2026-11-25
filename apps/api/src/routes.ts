import type { HttpHandler, HttpMethod } from "@azure/functions";
import { withAuth, type AuthenticatedHandler } from "./auth.js";
import { cookingAccess, mealPlanAccess, moneyAccess, pantryAccess, recipeStore, shoppingListAccess } from "./database.js";
import { createCookingHandler } from "./functions/cooking.js";
import { health } from "./functions/health.js";
import { meHandler } from "./functions/me.js";
import { createPantryHandlers } from "./functions/pantry.js";
import { createRecipeImportHandler } from "./functions/recipeImport.js";
import { createRecipeHandlers } from "./functions/recipes.js";
import { createPageFetcher } from "./recipes/import/fetchPage.js";
import { createShoppingListHandlers } from "./functions/shoppingList.js";
import { createMoneyHandlers } from "./functions/money.js";

const recipes = createRecipeHandlers(recipeStore);
const recipeImport = createRecipeImportHandler(recipeStore, createPageFetcher());

const pantry = createPantryHandlers(pantryAccess);
const cooked = createCookingHandler(cookingAccess);

import { createMealPlanHandlers } from "./functions/mealPlan.js";

const mealPlan = createMealPlanHandlers(mealPlanAccess);
const shopping = createShoppingListHandlers(shoppingListAccess);
const money = createMoneyHandlers(moneyAccess);

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
  { name: "recipeCooked", route: "recipes/{id}/cooked", methods: ["POST"], access: "household", handler: cooked },
  // Not under `recipes/`, where `recipes/{id}` would also match it.
  { name: "recipeImport", route: "recipe-import", methods: ["POST"], access: "household", handler: recipeImport },
  { name: "units", route: "units", methods: ["GET"], access: "household", handler: recipes.units },
  { name: "pantryList", route: "pantry/products", methods: ["GET"], access: "household", handler: pantry.list },
  { name: "pantryAdd", route: "pantry/products", methods: ["POST"], access: "household", handler: pantry.add },
  { name: "pantryUpdate", route: "pantry/products/{id}", methods: ["PATCH"], access: "household", handler: pantry.update },
  { name: "mealPlan", route: "meal-plan", methods: ["GET", "POST"], access: "household", handler: mealPlan.collection },
  { name: "mealPlanItem", route: "meal-plan/{id}", methods: ["PATCH", "DELETE"], access: "household", handler: mealPlan.item },
  { name: "shoppingList", route: "shopping-list", methods: ["GET", "POST"], access: "household", handler: shopping.collection },
  { name: "shoppingListItems", route: "shopping-list/{id}/items", methods: ["POST"], access: "household", handler: shopping.items },
  { name: "shoppingListItem", route: "shopping-list/{id}/items/{itemId}", methods: ["PATCH", "DELETE"], access: "household", handler: shopping.item },
  // Money (card $1). No route creates transactions or changes amounts or accounts (ADR-27).
  { name: "moneyAccounts", route: "money/accounts", methods: ["GET"], access: "household", handler: money.accounts },
  { name: "moneyCategories", route: "money/categories", methods: ["GET", "POST"], access: "household", handler: money.categories },
  { name: "moneyCategory", route: "money/categories/{id}", methods: ["PATCH"], access: "household", handler: money.category },
  { name: "moneyTransactions", route: "money/transactions", methods: ["GET"], access: "household", handler: money.transactions },
  { name: "moneyTransactionCategory", route: "money/transactions/{id}/category", methods: ["PUT"], access: "household", handler: money.transactionCategory },
  { name: "moneyTransactionSplits", route: "money/transactions/{id}/splits", methods: ["PUT"], access: "household", handler: money.transactionSplits },
  { name: "moneyRules", route: "money/rules", methods: ["GET", "POST"], access: "household", handler: money.rules },
  { name: "moneyRule", route: "money/rules/{id}", methods: ["PUT", "DELETE"], access: "household", handler: money.rule },
  { name: "moneyRuleOrder", route: "money/rule-order", methods: ["PUT"], access: "household", handler: money.ruleOrder },
  { name: "moneyApplyRules", route: "money/apply-rules", methods: ["POST"], access: "household", handler: money.applyRules },
];

export const routes: (RouteBase & { access: RouteSpec["access"]; handler: HttpHandler })[] = specs.map((spec) =>
  spec.access === "public" ? spec : { ...spec, handler: withAuth(spec.handler) },
);
