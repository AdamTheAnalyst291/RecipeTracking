import { HttpRequest, InvocationContext } from "@azure/functions";
import { CookingError, type Cooking } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createCookingHandler, type CookingAccess } from "./cooking.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPE = "11111111-1111-4111-8111-111111111111";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

const result = {
  eventId: "99999999-9999-4999-8999-999999999999",
  recipeId: RECIPE,
  servingsMade: 2,
  cookedAt: "2026-11-22T12:00:00.000Z",
  used: [{ product: "Flour", amount: 250, unit: "g" }],
  shortfalls: [],
};

function setup(cook: Cooking["cook"] = vi.fn(async () => result)) {
  const access: CookingAccess = async (who) => {
    expect(who).toBe(user);
    return { cooking: { cook } as Cooking, householdId: HOUSEHOLD };
  };
  return { cook, handler: createCookingHandler(access) };
}

function req(body?: unknown, id = RECIPE, method: "POST" | "GET" = "POST"): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071/api/recipes/${id}/cooked`,
    params: { id },
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("I made this", () => {
  it("cooks the recipe in the signed-in household and returns what happened", async () => {
    const { cook, handler } = setup();
    const response = await handler(req({ servingsMade: 2 }), ctx(), user);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(result);
    expect(cook).toHaveBeenCalledWith(HOUSEHOLD, RECIPE, { servingsMade: 2 });
  });

  it("works with no body, making the recipe's own servings", async () => {
    const { cook, handler } = setup();
    expect((await handler(req(), ctx(), user)).status).toBe(200);
    expect(cook).toHaveBeenCalledWith(HOUSEHOLD, RECIPE, {});
  });

  it.each([["not json"], [[1]], [{ servingsMade: "2" }], [{ servingsMade: null }]])("refuses a bad body %j with 400", async (body) => {
    const { cook, handler } = setup();
    const response = await handler(req(body), ctx(), user);
    expect(response.status).toBe(400);
    expect(cook).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that isn't an ID or a recipe that isn't there", async () => {
    const { handler } = setup(vi.fn(async () => Promise.reject(new CookingError("not-found", "No such recipe."))));
    expect((await handler(req(undefined, "nope"), ctx(), user)).status).toBe(404);
    expect((await handler(req(), ctx(), user)).status).toBe(404);
  });

  it("answers 400 when the store refuses the servings", async () => {
    const { handler } = setup(vi.fn(async () => Promise.reject(new CookingError("invalid", "Servings made must be above 0."))));
    const response = await handler(req({ servingsMade: 0 }), ctx(), user);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({ error: "Servings made must be above 0." });
  });

  it("answers 503 without leaking the database's message", async () => {
    const { handler } = setup(vi.fn(async () => Promise.reject(new Error("login failed for server sql-secret"))));
    const response = await handler(req(), ctx(), user);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.jsonBody)).not.toContain("sql-secret");
  });
});
