import { HttpRequest, InvocationContext } from "@azure/functions";
import { PantryError, type Pantry, type Product } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createPantryHandlers, runPantrySnapshot, type PantryAccess } from "./pantry.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

const flour: Product = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  foodId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Flour",
  unit: "g",
  unitId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  stockQuantity: 500,
  staple: true,
  packageQuantity: null,
  priceCents: null,
  priceDate: null,
};

function fakePantry(overrides: Partial<Record<keyof Pantry, unknown>> = {}) {
  const pantry = {
    addProduct: vi.fn(async () => flour),
    listProducts: vi.fn(async () => [flour]),
    adjustStock: vi.fn(async () => ({ ...flour, stockQuantity: 450 })),
    setStaple: vi.fn(async () => ({ ...flour, staple: false })),
    setPrice: vi.fn(async () => ({ ...flour, priceCents: 249 })),
    needsBuying: vi.fn(async () => []),
    snapshotAll: vi.fn(async () => 3),
    ...overrides,
  };
  const access: PantryAccess = async (who) => {
    expect(who).toBe(user);
    return { pantry: pantry as unknown as Pantry, householdId: HOUSEHOLD };
  };
  return { pantry, handlers: createPantryHandlers(access) };
}

function req(method: "GET" | "POST" | "PATCH", body?: unknown, id?: string): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071/api/pantry/products${id ? `/${id}` : ""}`,
    params: id ? { id } : {},
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("GET /api/pantry/products", () => {
  it("lists the products of the signed-in user's household", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.list(req("GET"), ctx(), user);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ products: [flour] });
    expect(pantry.listProducts).toHaveBeenCalledWith(HOUSEHOLD);
  });
});

describe("POST /api/pantry/products", () => {
  it("adds a product to the household and answers 201", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.add(req("POST", { foodId: flour.foodId, unitId: flour.unitId, name: "Flour", staple: true, stockQuantity: 500 }), ctx(), user);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual(flour);
    expect(pantry.addProduct).toHaveBeenCalledWith(HOUSEHOLD, { foodId: flour.foodId, unitId: flour.unitId, name: "Flour", staple: true, stockQuantity: 500 });
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an object", [1]],
    ["missing the food", { unitId: flour.unitId }],
    ["missing the unit", { foodId: flour.foodId }],
    ["a stock that is not a number", { foodId: flour.foodId, unitId: flour.unitId, stockQuantity: "lots" }],
    ["a staple flag that is not a boolean", { foodId: flour.foodId, unitId: flour.unitId, staple: "yes" }],
  ])("answers 400 to %s", async (_name, body) => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.add(req("POST", body), ctx(), user);

    expect(response.status).toBe(400);
    expect(pantry.addProduct).not.toHaveBeenCalled();
  });

  it("answers 404 when the food belongs to another household", async () => {
    const { handlers } = fakePantry({ addProduct: vi.fn(async () => { throw new PantryError("not-found", "No such food."); }) });

    const response = await handlers.add(req("POST", { foodId: flour.foodId, unitId: flour.unitId }), ctx(), user);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({ error: "No such food." });
  });
});

describe("PATCH /api/pantry/products/{id}", () => {
  it("sets stock exactly", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.update(req("PATCH", { stock: { set: 450 } }, flour.id), ctx(), user);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ stockQuantity: 450 });
    expect(pantry.adjustStock).toHaveBeenCalledWith(HOUSEHOLD, flour.id, { set: 450 });
  });

  it("changes stock by an amount", async () => {
    const { pantry, handlers } = fakePantry();

    await handlers.update(req("PATCH", { stock: { delta: -50 } }, flour.id), ctx(), user);

    expect(pantry.adjustStock).toHaveBeenCalledWith(HOUSEHOLD, flour.id, { delta: -50 });
  });

  it("changes the staple flag", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.update(req("PATCH", { staple: false }, flour.id), ctx(), user);

    expect(response.jsonBody).toMatchObject({ staple: false });
    expect(pantry.setStaple).toHaveBeenCalledWith(HOUSEHOLD, flour.id, false);
  });

  it("updates the price", async () => {
    const { pantry, handlers } = fakePantry();
    const price = { priceCents: 249, packageQuantity: 1500, date: "2026-11-22" };

    const response = await handlers.update(req("PATCH", { price }, flour.id), ctx(), user);

    expect(response.jsonBody).toMatchObject({ priceCents: 249 });
    expect(pantry.setPrice).toHaveBeenCalledWith(HOUSEHOLD, flour.id, price);
  });

  it("applies several changes in one request and answers with the product as it ends up", async () => {
    const { pantry, handlers } = fakePantry();

    await handlers.update(req("PATCH", { stock: { set: 1 }, staple: false }, flour.id), ctx(), user);

    expect(pantry.adjustStock).toHaveBeenCalledTimes(1);
    expect(pantry.setStaple).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad price before moving the stock, so nothing is half-applied", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.update(
      req("PATCH", { stock: { set: 1 }, price: { priceCents: 1, packageQuantity: 1, date: "yesterday" } }, flour.id),
      ctx(),
      user,
    );

    expect(response.status).toBe(400);
    expect(pantry.adjustStock).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing to change", {}],
    ["a stock with both set and delta", { stock: { set: 1, delta: 1 } }],
    ["a stock with neither", { stock: {} }],
    ["a stock that is not a number", { stock: { set: "1" } }],
    ["a price missing its date", { price: { priceCents: 1, packageQuantity: 1 } }],
    ["a staple that is not a boolean", { staple: 1 }],
    ["not JSON", "{nope"],
  ])("answers 400 to %s and changes nothing", async (_name, body) => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.update(req("PATCH", body, flour.id), ctx(), user);

    expect(response.status).toBe(400);
    expect(pantry.adjustStock).not.toHaveBeenCalled();
    expect(pantry.setStaple).not.toHaveBeenCalled();
    expect(pantry.setPrice).not.toHaveBeenCalled();
  });

  it("answers 404 for a product that is not in the household", async () => {
    const { handlers } = fakePantry({ adjustStock: vi.fn(async () => { throw new PantryError("not-found", "No such product."); }) });

    const response = await handlers.update(req("PATCH", { stock: { set: 1 } }, flour.id), ctx(), user);

    expect(response.status).toBe(404);
  });

  it("answers 400 with the reason when the store refuses a value", async () => {
    const { handlers } = fakePantry({ adjustStock: vi.fn(async () => { throw new PantryError("invalid", "Stock can't go below 0."); }) });

    const response = await handlers.update(req("PATCH", { stock: { delta: -9999 } }, flour.id), ctx(), user);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({ error: "Stock can't go below 0." });
  });

  it("answers 400 for an id that is not a GUID, without asking the database", async () => {
    const { pantry, handlers } = fakePantry();

    const response = await handlers.update(req("PATCH", { staple: true }, "not-a-guid"), ctx(), user);

    expect(response.status).toBe(400);
    expect(pantry.setStaple).not.toHaveBeenCalled();
  });
});

describe("when the database can't be reached", () => {
  it("answers 503 rather than leaking the error", async () => {
    const down: PantryAccess = async () => {
      throw new Error("Login failed for user 'secret-name'");
    };
    const handlers = createPantryHandlers(down);

    const response = await handlers.list(req("GET"), ctx(), user);

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.jsonBody)).not.toContain("secret-name");
  });
});

describe("the daily snapshot", () => {
  it("snapshots under today's UTC date", async () => {
    const { pantry } = fakePantry();

    const written = await runPantrySnapshot(pantry as unknown as Pantry, new Date("2026-11-22T23:59:30Z"), ctx());

    expect(written).toBe(3);
    expect(pantry.snapshotAll).toHaveBeenCalledWith("2026-11-22");
  });

  it("lets a failure through, so the Functions host records the run as failed", async () => {
    const { pantry } = fakePantry({ snapshotAll: vi.fn(async () => { throw new Error("db down"); }) });

    await expect(runPantrySnapshot(pantry as unknown as Pantry, new Date("2026-11-22T00:05:00Z"), ctx())).rejects.toThrow("db down");
  });
});
