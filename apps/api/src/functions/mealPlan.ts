import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { MealPlanError, type MealPlan } from "@kitchen/db";
import type { ApiError, MealPlanWeekResponse, NewPlannedMeal, PlannedMealChange } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** The meal plan of the signed-in user's household, and that household's id. */
export type MealPlanAccess = (user: SignedInUser) => Promise<{ plan: MealPlan; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a request that can't be used; becomes a 400 with the message. */
class BadRequest extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readObject(request: HttpRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (!isObject(body)) throw new BadRequest("The body must be a JSON object.");
  return body;
}

function optional<T>(body: Record<string, unknown>, key: string, type: "string" | "number"): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new BadRequest(`${key} must be a ${type}.`);
  return value as T;
}

function required(body: Record<string, unknown>, key: string): string {
  const value = optional<string>(body, key, "string");
  if (value === undefined || value === "") throw new BadRequest(`${key} is required.`);
  return value;
}

function parseNew(body: Record<string, unknown>): NewPlannedMeal {
  const meal = { date: required(body, "date"), slot: required(body, "slot"), recipeId: required(body, "recipeId") } as NewPlannedMeal;
  if (!GUID.test(meal.recipeId)) throw new BadRequest("recipeId must be an ID.");
  const servings = optional<number>(body, "servings", "number");
  if (servings !== undefined) meal.servings = servings;
  return meal;
}

function parseChange(body: Record<string, unknown>): PlannedMealChange {
  const change: PlannedMealChange = {};
  const date = optional<string>(body, "date", "string");
  const slot = optional<string>(body, "slot", "string");
  const servings = optional<number>(body, "servings", "number");
  if (date !== undefined) change.date = date;
  if (slot !== undefined) change.slot = slot as PlannedMealChange["slot"];
  if (servings !== undefined) change.servings = servings;
  if (Object.keys(change).length === 0) throw new BadRequest("Send at least one of date, slot or servings.");
  return change;
}

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });

/** Wraps a plan call: bad input and store refusals become 4xx, anything else (usually the database) 503. */
async function respond(context: InvocationContext, run: () => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    if (error instanceof MealPlanError) return fail(error.code === "not-found" ? 404 : 400, error.message);
    // The message may name the server or login, so it goes to the log and not to the caller.
    context.error("The meal plan could not reach the database", error);
    return fail(503, "The meal plan isn't available right now. Try again shortly.");
  }
}

/** The meal plan routes: `/meal-plan` (a week, add) and `/meal-plan/{id}` (move or re-serve, remove). */
export function createMealPlanHandlers(access: MealPlanAccess): Record<"collection" | "item", AuthenticatedHandler> {
  return {
    collection: (request, context, user) =>
      respond(context, async () => {
        if (request.method === "GET") {
          const start = request.query.get("start");
          if (!start) throw new BadRequest("start is required, like 2026-11-23.");
          const { plan, householdId } = await access(user);
          const body: MealPlanWeekResponse = { start, meals: await plan.listWeek(householdId, start) };
          return { status: 200, jsonBody: body };
        }
        if (request.method === "POST") {
          const meal = parseNew(await readObject(request));
          const { plan, householdId } = await access(user);
          const added = await plan.add(householdId, meal);
          return { status: 201, headers: { Location: `/api/meal-plan/${added.id}` }, jsonBody: added };
        }
        return fail(405, "Method not allowed.");
      }),

    item: (request, context, user) =>
      respond(context, async () => {
        if (request.method !== "PATCH" && request.method !== "DELETE") return fail(405, "Method not allowed.");
        const id = request.params.id ?? "";
        if (!GUID.test(id)) throw new BadRequest("The planned meal id isn't an ID.");
        if (request.method === "PATCH") {
          const change = parseChange(await readObject(request));
          const { plan, householdId } = await access(user);
          return { status: 200, jsonBody: await plan.update(householdId, id, change) };
        }
        const { plan, householdId } = await access(user);
        await plan.remove(householdId, id);
        return { status: 204 };
      }),
  };
}
