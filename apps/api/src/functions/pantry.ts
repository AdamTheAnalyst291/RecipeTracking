import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { PantryError, type Pantry } from "@kitchen/db";
import type { ApiError, NewPantryProduct, PantryProductChange, PantryResponse } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** The pantry of the signed-in user's household, and that household's id. */
export type PantryAccess = (user: SignedInUser) => Promise<{ pantry: Pantry; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (error: string): HttpResponseInit => ({ status: 400, jsonBody: { error } satisfies ApiError });

/** Thrown for a request body that can't be used; becomes a 400 with the message. */
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

function optional<T>(body: Record<string, unknown>, key: string, type: "string" | "number" | "boolean"): T | undefined {
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

function parseNewProduct(body: Record<string, unknown>): NewPantryProduct {
  const product: NewPantryProduct = { foodId: required(body, "foodId"), unitId: required(body, "unitId") };
  const name = optional<string>(body, "name", "string");
  const staple = optional<boolean>(body, "staple", "boolean");
  const stockQuantity = optional<number>(body, "stockQuantity", "number");
  if (name !== undefined) product.name = name;
  if (staple !== undefined) product.staple = staple;
  if (stockQuantity !== undefined) product.stockQuantity = stockQuantity;
  for (const id of [product.foodId, product.unitId]) {
    if (!GUID.test(id)) throw new BadRequest("foodId and unitId must be IDs.");
  }
  return product;
}

function parseChange(body: Record<string, unknown>): PantryProductChange {
  const change: PantryProductChange = {};
  if (body.stock !== undefined) {
    const stock = body.stock;
    if (!isObject(stock)) throw new BadRequest("stock must be { set: n } or { delta: n }.");
    const set = optional<number>(stock, "set", "number");
    const delta = optional<number>(stock, "delta", "number");
    if ((set === undefined) === (delta === undefined)) throw new BadRequest("stock must have exactly one of set or delta.");
    change.stock = set !== undefined ? { set } : { delta: delta as number };
  }
  const staple = optional<boolean>(body, "staple", "boolean");
  if (staple !== undefined) change.staple = staple;
  if (body.price !== undefined) {
    const price = body.price;
    if (!isObject(price)) throw new BadRequest("price must be { priceCents, packageQuantity, date }.");
    change.price = {
      priceCents: optional<number>(price, "priceCents", "number") ?? failMissing("priceCents"),
      packageQuantity: optional<number>(price, "packageQuantity", "number") ?? failMissing("packageQuantity"),
      date: optional<string>(price, "date", "string") ?? failMissing("date"),
    };
  }
  if (Object.keys(change).length === 0) throw new BadRequest("Send at least one of stock, staple or price.");
  return change;
}

const failMissing = (key: string): never => {
  throw new BadRequest(`price.${key} is required.`);
};

/** Wraps a pantry call: bad input and store refusals become 4xx, anything else (usually the database) 503. */
async function respond(context: InvocationContext, run: () => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequest) return bad(error.message);
    if (error instanceof PantryError) {
      return { status: error.code === "not-found" ? 404 : 400, jsonBody: { error: error.message } satisfies ApiError };
    }
    // The message may name the server or login, so it goes to the log and not to the caller.
    context.error("The pantry could not reach the database", error);
    return { status: 503, jsonBody: { error: "The pantry isn't available right now. Try again shortly." } satisfies ApiError };
  }
}

/** The pantry routes. They take the database through `access`, so tests can swap it. */
export function createPantryHandlers(access: PantryAccess): Record<"list" | "add" | "update", AuthenticatedHandler> {
  return {
    list: (_request, context, user) =>
      respond(context, async () => {
        const { pantry, householdId } = await access(user);
        const body: PantryResponse = { products: await pantry.listProducts(householdId) };
        return { status: 200, jsonBody: body };
      }),

    add: (request, context, user) =>
      respond(context, async () => {
        const product = parseNewProduct(await readObject(request));
        const { pantry, householdId } = await access(user);
        return { status: 201, jsonBody: await pantry.addProduct(householdId, product) };
      }),

    update: (request, context, user) =>
      respond(context, async () => {
        const id = request.params.id ?? "";
        if (!GUID.test(id)) throw new BadRequest("The product id isn't an ID.");
        const change = parseChange(await readObject(request));
        const { pantry, householdId } = await access(user);
        let product;
        if (change.stock) product = await pantry.adjustStock(householdId, id, change.stock);
        if (change.staple !== undefined) product = await pantry.setStaple(householdId, id, change.staple);
        if (change.price) product = await pantry.setPrice(householdId, id, change.price);
        return { status: 200, jsonBody: product };
      }),
  };
}

/** The daily timer's work: one stock-and-price row per product under today's UTC date. */
export async function runPantrySnapshot(pantry: Pantry, now: Date, context: InvocationContext): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const written = await pantry.snapshotAll(day);
  context.log(`Pantry snapshot for ${day}: ${written} product(s)`);
  return written;
}
