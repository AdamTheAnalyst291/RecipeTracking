import { HttpRequest, InvocationContext } from "@azure/functions";
import { MealPlanError, type MealPlan, type PlannedMeal } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createMealPlanHandlers, type MealPlanAccess } from "./mealPlan.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

const dinner: PlannedMeal = { id: MEAL_ID, date: "2026-11-24", slot: "dinner", recipeId: RECIPE, recipeName: "Lentil soup", servings: 4 };

function fakePlan(overrides: Partial<Record<keyof MealPlan, unknown>> = {}) {
  const plan = {
    listWeek: vi.fn(async () => [dinner]),
    add: vi.fn(async () => dinner),
    update: vi.fn(async () => ({ ...dinner, servings: 2 })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
  const access: MealPlanAccess = async (who) => {
    expect(who).toBe(user);
    return { plan: plan as unknown as MealPlan, householdId: HOUSEHOLD };
  };
  return { plan, handlers: createMealPlanHandlers(access) };
}

function req(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", { body, id, query = "" }: { body?: unknown; id?: string; query?: string } = {}): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071/api/meal-plan${id ? `/${id}` : ""}${query}`,
    params: id ? { id } : {},
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("GET /api/meal-plan", () => {
  it("lists the week from the start date for the signed-in user's household", async () => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.collection(req("GET", { query: "?start=2026-11-23" }), ctx(), user);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ start: "2026-11-23", meals: [dinner] });
    expect(plan.listWeek).toHaveBeenCalledWith(HOUSEHOLD, "2026-11-23");
  });

  it("wants a start date", async () => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.collection(req("GET"), ctx(), user);

    expect(response.status).toBe(400);
    expect(plan.listWeek).not.toHaveBeenCalled();
  });

  it("answers 400 when the store refuses the date", async () => {
    const { handlers } = fakePlan({
      listWeek: vi.fn(async () => {
        throw new MealPlanError("invalid", "The week start must be a date like 2026-11-22.");
      }),
    });

    const response = await handlers.collection(req("GET", { query: "?start=soon" }), ctx(), user);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({ error: "The week start must be a date like 2026-11-22." });
  });
});

describe("POST /api/meal-plan", () => {
  it("plans a meal and answers 201", async () => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.collection(req("POST", { body: { date: "2026-11-24", slot: "dinner", recipeId: RECIPE, servings: 4 } }), ctx(), user);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual(dinner);
    expect(plan.add).toHaveBeenCalledWith(HOUSEHOLD, { date: "2026-11-24", slot: "dinner", recipeId: RECIPE, servings: 4 });
  });

  it("leaves servings out when none are sent", async () => {
    const { plan, handlers } = fakePlan();

    await handlers.collection(req("POST", { body: { date: "2026-11-24", slot: "dinner", recipeId: RECIPE } }), ctx(), user);

    expect(plan.add).toHaveBeenCalledWith(HOUSEHOLD, { date: "2026-11-24", slot: "dinner", recipeId: RECIPE });
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an object", [1]],
    ["missing the date", { slot: "dinner", recipeId: RECIPE }],
    ["missing the slot", { date: "2026-11-24", recipeId: RECIPE }],
    ["missing the recipe", { date: "2026-11-24", slot: "dinner" }],
    ["a recipe that is not an ID", { date: "2026-11-24", slot: "dinner", recipeId: "soup" }],
    ["servings that are not a number", { date: "2026-11-24", slot: "dinner", recipeId: RECIPE, servings: "four" }],
  ])("answers 400 for %s", async (_what, body) => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.collection(req("POST", { body }), ctx(), user);

    expect(response.status).toBe(400);
    expect(plan.add).not.toHaveBeenCalled();
  });

  it("answers 404 for a recipe the store doesn't know", async () => {
    const { handlers } = fakePlan({
      add: vi.fn(async () => {
        throw new MealPlanError("not-found", "No such recipe.");
      }),
    });

    const response = await handlers.collection(req("POST", { body: { date: "2026-11-24", slot: "dinner", recipeId: RECIPE } }), ctx(), user);

    expect(response.status).toBe(404);
  });

  it("answers 405 for other methods", async () => {
    const { handlers } = fakePlan();

    expect((await handlers.collection(req("PUT"), ctx(), user)).status).toBe(405);
  });
});

describe("PATCH /api/meal-plan/{id}", () => {
  it("moves a meal and changes its servings", async () => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.item(req("PATCH", { id: MEAL_ID, body: { date: "2026-11-26", slot: "lunch", servings: 2 } }), ctx(), user);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ ...dinner, servings: 2 });
    expect(plan.update).toHaveBeenCalledWith(HOUSEHOLD, MEAL_ID, { date: "2026-11-26", slot: "lunch", servings: 2 });
  });

  it.each([
    ["an id that isn't an ID", "nope", { servings: 2 }],
    ["nothing to change", MEAL_ID, {}],
    ["servings that are not a number", MEAL_ID, { servings: "two" }],
    ["a slot that is not text", MEAL_ID, { slot: 3 }],
    ["not JSON", MEAL_ID, "{nope"],
  ])("answers 400 for %s", async (_what, id, body) => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.item(req("PATCH", { id, body }), ctx(), user);

    expect(response.status).toBe(400);
    expect(plan.update).not.toHaveBeenCalled();
  });

  it("answers 404 for a meal that isn't there", async () => {
    const { handlers } = fakePlan({
      update: vi.fn(async () => {
        throw new MealPlanError("not-found", "No such planned meal.");
      }),
    });

    expect((await handlers.item(req("PATCH", { id: MEAL_ID, body: { servings: 2 } }), ctx(), user)).status).toBe(404);
  });
});

describe("DELETE /api/meal-plan/{id}", () => {
  it("removes the meal and answers 204", async () => {
    const { plan, handlers } = fakePlan();

    const response = await handlers.item(req("DELETE", { id: MEAL_ID }), ctx(), user);

    expect(response.status).toBe(204);
    expect(plan.remove).toHaveBeenCalledWith(HOUSEHOLD, MEAL_ID);
  });

  it("answers 404 for a meal that isn't there", async () => {
    const { handlers } = fakePlan({
      remove: vi.fn(async () => {
        throw new MealPlanError("not-found", "No such planned meal.");
      }),
    });

    expect((await handlers.item(req("DELETE", { id: MEAL_ID }), ctx(), user)).status).toBe(404);
  });

  it("answers 405 for other methods", async () => {
    const { handlers } = fakePlan();

    expect((await handlers.item(req("GET", { id: MEAL_ID }), ctx(), user)).status).toBe(405);
  });
});

describe("when the database is unavailable", () => {
  it("answers 503 without leaking the reason", async () => {
    const { handlers } = fakePlan({
      listWeek: vi.fn(async () => {
        throw new Error("login failed for sql-secret.database.windows.net");
      }),
    });

    const response = await handlers.collection(req("GET", { query: "?start=2026-11-23" }), ctx(), user);

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.jsonBody)).not.toContain("sql-secret");
  });
});
