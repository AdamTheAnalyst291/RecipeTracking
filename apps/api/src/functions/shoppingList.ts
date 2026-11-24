import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ShoppingListError, type ShoppingLists } from "@kitchen/db";
import type { ApiError, NewShoppingItem, ShoppingListResponse } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** The shopping lists of the signed-in user's household, and that household's id. */
export type ShoppingListAccess = (user: SignedInUser) => Promise<{ lists: ShoppingLists; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a request that can't be used; becomes a 400 with the message. */
class BadRequest extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON object in the body; an empty body counts as `{}` when `allowEmpty`. */
async function readObject(request: HttpRequest, allowEmpty = false): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (allowEmpty && text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (!isObject(body)) throw new BadRequest("The body must be a JSON object.");
  return body;
}

function optional<T>(body: Record<string, unknown>, key: string, type: "string" | "number" | "boolean"): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new BadRequest(`${key} must be a ${type}.`);
  return value as T;
}

function idParam(request: HttpRequest, key: string, what: string): string {
  const id = request.params[key] ?? "";
  if (!GUID.test(id)) throw new BadRequest(`The ${what} id isn't an ID.`);
  return id;
}

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });

async function respond(context: InvocationContext, run: () => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    if (error instanceof ShoppingListError) return fail(error.code === "not-found" ? 404 : 400, error.message);
    // The message may name the server or login, so it goes to the log and not to the caller.
    context.error("The shopping list could not reach the database", error);
    return fail(503, "The shopping list isn't available right now. Try again shortly.");
  }
}

const day = (date: Date): string => date.toISOString().slice(0, 10);
function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return day(d);
}

/**
 * The shopping list routes: `/shopping-list` (latest, build a new one), `.../{id}/items` (add
 * by hand) and `.../{id}/items/{itemId}` (check off, remove). `now` is for tests.
 */
export function createShoppingListHandlers(
  access: ShoppingListAccess,
  now: () => Date = () => new Date(),
): Record<"collection" | "items" | "item", AuthenticatedHandler> {
  return {
    collection: (request, context, user) =>
      respond(context, async () => {
        if (request.method === "GET") {
          const { lists, householdId } = await access(user);
          const body: ShoppingListResponse = { list: (await lists.latest(householdId)) ?? null };
          return { status: 200, jsonBody: body };
        }
        if (request.method === "POST") {
          const body = await readObject(request, true);
          const given = { start: optional<string>(body, "start", "string"), end: optional<string>(body, "end", "string") };
          const start = given.start ?? day(now());
          // An invalid start is the store's to refuse; only work out the end when the start is a plain date.
          const end = given.end ?? (/^\d{4}-\d{2}-\d{2}$/.test(start) && !Number.isNaN(Date.parse(start)) ? plusDays(start, 6) : start);
          const { lists, householdId } = await access(user);
          return { status: 201, jsonBody: await lists.generate(householdId, start, end) };
        }
        return fail(405, "Method not allowed.");
      }),

    items: (request, context, user) =>
      respond(context, async () => {
        if (request.method !== "POST") return fail(405, "Method not allowed.");
        const listId = idParam(request, "id", "shopping list");
        const body = await readObject(request);
        const name = optional<string>(body, "name", "string");
        if (name === undefined || name.trim() === "") throw new BadRequest("name is required.");
        const item: NewShoppingItem = { name };
        const quantity = optional<number>(body, "quantity", "number");
        const unitId = optional<string>(body, "unitId", "string");
        if (quantity !== undefined) item.quantity = quantity;
        if (unitId !== undefined) {
          if (!GUID.test(unitId)) throw new BadRequest("unitId must be an ID.");
          item.unitId = unitId;
        }
        const { lists, householdId } = await access(user);
        return { status: 201, jsonBody: await lists.addItem(householdId, listId, item) };
      }),

    item: (request, context, user) =>
      respond(context, async () => {
        if (request.method !== "PATCH" && request.method !== "DELETE") return fail(405, "Method not allowed.");
        const listId = idParam(request, "id", "shopping list");
        const itemId = idParam(request, "itemId", "item");
        if (request.method === "PATCH") {
          const checked = optional<boolean>(await readObject(request), "checked", "boolean");
          if (checked === undefined) throw new BadRequest("checked is required.");
          const { lists, householdId } = await access(user);
          return { status: 200, jsonBody: await lists.setChecked(householdId, listId, itemId, checked) };
        }
        const { lists, householdId } = await access(user);
        await lists.removeItem(householdId, listId, itemId);
        return { status: 204 };
      }),
  };
}
