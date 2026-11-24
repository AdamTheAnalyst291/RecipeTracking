import { HttpRequest, InvocationContext } from "@azure/functions";
import { ShoppingListError, type ShoppingItem, type ShoppingList, type ShoppingLists } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createShoppingListHandlers, type ShoppingListAccess } from "./shoppingList.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNIT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

const item: ShoppingItem = { id: ITEM, foodId: null, name: "Milk", quantity: 2, unit: "l", unitId: UNIT, source: "manual", checked: false };
const list: ShoppingList = { id: LIST, start: "2026-11-23", end: "2026-11-29", createdAt: "2026-11-23T08:00:00.000Z", items: [item] };

function fake(overrides: Partial<Record<keyof ShoppingLists, unknown>> = {}, now = new Date("2026-11-23T10:00:00Z")) {
  const lists = {
    latest: vi.fn(async () => list),
    generate: vi.fn(async () => list),
    addItem: vi.fn(async () => item),
    setChecked: vi.fn(async () => ({ ...item, checked: true })),
    removeItem: vi.fn(async () => undefined),
    ...overrides,
  };
  const access: ShoppingListAccess = async (who) => {
    expect(who).toBe(user);
    return { lists: lists as unknown as ShoppingLists, householdId: HOUSEHOLD };
  };
  return { lists, handlers: createShoppingListHandlers(access, () => now) };
}

function req(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", { body, params = {} }: { body?: unknown; params?: Record<string, string> } = {}): HttpRequest {
  return new HttpRequest({
    method,
    url: "http://localhost:7071/api/shopping-list",
    params,
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("GET /api/shopping-list", () => {
  it("returns the latest list for the household, or null", async () => {
    const { lists, handlers } = fake();
    expect((await handlers.collection(req("GET"), ctx(), user)).jsonBody).toEqual({ list });
    expect(lists.latest).toHaveBeenCalledWith(HOUSEHOLD);

    const none = fake({ latest: vi.fn(async () => undefined) });
    expect((await none.handlers.collection(req("GET"), ctx(), user)).jsonBody).toEqual({ list: null });
  });
});

describe("POST /api/shopping-list", () => {
  it("builds a list for the dates given", async () => {
    const { lists, handlers } = fake();
    const response = await handlers.collection(req("POST", { body: { start: "2026-11-24", end: "2026-11-30" } }), ctx(), user);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual(list);
    expect(lists.generate).toHaveBeenCalledWith(HOUSEHOLD, "2026-11-24", "2026-11-30");
  });

  it("defaults to the coming week: today and the six days after", async () => {
    const { lists, handlers } = fake();
    await handlers.collection(req("POST"), ctx(), user);
    expect(lists.generate).toHaveBeenCalledWith(HOUSEHOLD, "2026-11-23", "2026-11-29");
  });

  it("defaults the end to six days after a start that was given", async () => {
    const { lists, handlers } = fake();
    await handlers.collection(req("POST", { body: { start: "2026-12-30" } }), ctx(), user);
    expect(lists.generate).toHaveBeenCalledWith(HOUSEHOLD, "2026-12-30", "2027-01-05");
  });

  it("answers 400 for a body that isn't an object or has the wrong types, and when the store refuses", async () => {
    const { lists, handlers } = fake({ generate: vi.fn(async () => Promise.reject(new ShoppingListError("invalid", "nope"))) });
    expect((await handlers.collection(req("POST", { body: "[1]" }), ctx(), user)).status).toBe(400);
    expect((await handlers.collection(req("POST", { body: { start: 5 } }), ctx(), user)).status).toBe(400);
    expect((await handlers.collection(req("POST", { body: { start: "x" } }), ctx(), user)).status).toBe(400);
    expect(lists.generate).toHaveBeenCalledTimes(1);
  });

  it("answers 503 without leaking the reason when the database is down", async () => {
    const { handlers } = fake({ generate: vi.fn(async () => Promise.reject(new Error("server sql-secret.database.windows.net refused"))) });
    const response = await handlers.collection(req("POST"), ctx(), user);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.jsonBody)).not.toContain("sql-secret");
  });
});

describe("POST /api/shopping-list/{id}/items", () => {
  it("adds an item by hand", async () => {
    const { lists, handlers } = fake();
    const response = await handlers.items(req("POST", { params: { id: LIST }, body: { name: "Milk", quantity: 2, unitId: UNIT } }), ctx(), user);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual(item);
    expect(lists.addItem).toHaveBeenCalledWith(HOUSEHOLD, LIST, { name: "Milk", quantity: 2, unitId: UNIT });
  });

  it("needs a name, a list id and an id-shaped unit", async () => {
    const { lists, handlers } = fake();
    expect((await handlers.items(req("POST", { params: { id: LIST }, body: {} }), ctx(), user)).status).toBe(400);
    expect((await handlers.items(req("POST", { params: { id: "x" }, body: { name: "Milk" } }), ctx(), user)).status).toBe(400);
    expect((await handlers.items(req("POST", { params: { id: LIST }, body: { name: "Milk", unitId: "g" } }), ctx(), user)).status).toBe(400);
    expect(lists.addItem).not.toHaveBeenCalled();
  });

  it("answers 404 when the list isn't the household's", async () => {
    const { handlers } = fake({ addItem: vi.fn(async () => Promise.reject(new ShoppingListError("not-found", "No such shopping list."))) });
    expect((await handlers.items(req("POST", { params: { id: LIST }, body: { name: "Milk" } }), ctx(), user)).status).toBe(404);
  });
});

describe("/api/shopping-list/{id}/items/{itemId}", () => {
  const params = { id: LIST, itemId: ITEM };

  it("checks an item off", async () => {
    const { lists, handlers } = fake();
    const response = await handlers.item(req("PATCH", { params, body: { checked: true } }), ctx(), user);
    expect(response.status).toBe(200);
    expect(lists.setChecked).toHaveBeenCalledWith(HOUSEHOLD, LIST, ITEM, true);
  });

  it("wants checked to be true or false", async () => {
    const { lists, handlers } = fake();
    expect((await handlers.item(req("PATCH", { params, body: { checked: "yes" } }), ctx(), user)).status).toBe(400);
    expect((await handlers.item(req("PATCH", { params, body: {} }), ctx(), user)).status).toBe(400);
    expect(lists.setChecked).not.toHaveBeenCalled();
  });

  it("removes an item with 204, and 404 when it isn't there", async () => {
    const { lists, handlers } = fake();
    expect((await handlers.item(req("DELETE", { params }), ctx(), user)).status).toBe(204);
    expect(lists.removeItem).toHaveBeenCalledWith(HOUSEHOLD, LIST, ITEM);

    const missing = fake({ removeItem: vi.fn(async () => Promise.reject(new ShoppingListError("not-found", "No such item."))) });
    expect((await missing.handlers.item(req("DELETE", { params }), ctx(), user)).status).toBe(404);
  });

  it("refuses ids that aren't ids", async () => {
    const { handlers } = fake();
    expect((await handlers.item(req("DELETE", { params: { id: LIST, itemId: "x" } }), ctx(), user)).status).toBe(400);
  });
});
