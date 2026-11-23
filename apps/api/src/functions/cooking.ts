import type { HttpResponseInit, InvocationContext } from "@azure/functions";
import { CookingError, type Cooking } from "@kitchen/db";
import type { ApiError, CookedRequest, CookedResponse } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** Cooking for the signed-in user's household, and that household's id. */
export type CookingAccess = (user: SignedInUser) => Promise<{ cooking: Cooking; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });

/** `POST /api/recipes/{id}/cooked`: "I made this". The body is optional: `{ servingsMade }`. */
export function createCookingHandler(access: CookingAccess): AuthenticatedHandler {
  return async (request, context: InvocationContext, user) => {
    const id = request.params.id ?? "";
    if (!GUID.test(id)) return reply(404, "No such recipe.");

    const options: CookedRequest = {};
    const text = await request.text();
    if (text.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return reply(400, "The body must be JSON.");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(400, "The body must be a JSON object.");
      const servings = (body as Record<string, unknown>).servingsMade;
      if (servings !== undefined) {
        if (typeof servings !== "number") return reply(400, "servingsMade must be a number.");
        options.servingsMade = servings;
      }
    }

    try {
      const { cooking, householdId } = await access(user);
      const body: CookedResponse = await cooking.cook(householdId, id, options);
      return { status: 200, jsonBody: body };
    } catch (error) {
      if (error instanceof CookingError) return reply(error.code === "not-found" ? 404 : 400, error.message);
      // The message may name the server or login, so it goes to the log and not to the caller.
      context.error("Cooking could not reach the database", error);
      return reply(503, "Couldn't save that right now. Try again shortly.");
    }
  };
}
