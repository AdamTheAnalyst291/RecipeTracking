import { HttpRequest, InvocationContext } from "@azure/functions";
import { MoneyError, type Money, type Rule, type Transaction } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createMoneyHandlers, type MoneyAccess } from "./money.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAT2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

// Made up; the repo is public.
const tx: Transaction = {
  id: TX,
  accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  account: "Everyday Checking",
  date: "2026-11-02",
  amountCents: -8437,
  payee: "Sample Grocer",
  description: "SAMPLE GROCER #12",
  plaidTransactionId: "tx-0001",
  categoryId: CAT,
  category: "Groceries",
  categorySource: "manual",
  splits: [],
};
const rule: Rule = { id: RULE, position: 1, field: "payee", match: "contains", pattern: "grocer", categoryId: CAT, category: "Groceries" };

function fake(overrides: Partial<Record<keyof Money, unknown>> = {}) {
  const money = {
    accounts: vi.fn(async () => [{ id: tx.accountId, name: "Everyday Checking", mask: "0000" }]),
    categories: vi.fn(async () => [{ id: CAT, name: "Groceries", kind: "spending" }]),
    addCategory: vi.fn(async (_h: string, name: string, kind = "spending") => ({ id: CAT, name, kind })),
    renameCategory: vi.fn(async (_h: string, id: string, name: string) => ({ id, name, kind: "spending" })),
    updateCategory: vi.fn(async (_h: string, id: string, change: { name?: string; kind?: string }) => ({ id, name: "Groceries", kind: "spending", ...change })),
    transactions: vi.fn(async () => [tx]),
    setCategory: vi.fn(async () => tx),
    setSplits: vi.fn(async () => tx),
    rules: vi.fn(async () => [rule]),
    addRule: vi.fn(async () => rule),
    updateRule: vi.fn(async () => rule),
    removeRule: vi.fn(async () => undefined),
    reorderRules: vi.fn(async () => [rule]),
    applyRules: vi.fn(async () => ({ categorized: 2 })),
    importPlaid: vi.fn(),
    ...overrides,
  };
  const access: MoneyAccess = async (who) => {
    expect(who).toBe(user);
    return { money: money as unknown as Money, householdId: HOUSEHOLD };
  };
  return { money, handlers: createMoneyHandlers(access) };
}

function req(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  { body, params = {}, query = "" }: { body?: unknown; params?: Record<string, string>; query?: string } = {},
): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071/api/money${query}`,
    params,
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("money transactions", () => {
  it("lists the household's transactions, newest first, optionally only uncategorized", async () => {
    const { money, handlers } = fake();
    expect((await handlers.transactions(req("GET"), ctx(), user)).jsonBody).toEqual({ transactions: [tx] });
    expect(money.transactions).toHaveBeenCalledWith(HOUSEHOLD, {});
    await handlers.transactions(req("GET", { query: "?uncategorized=true&limit=50" }), ctx(), user);
    expect(money.transactions).toHaveBeenLastCalledWith(HOUSEHOLD, { uncategorized: true, limit: 50 });
  });

  it("answers 400 for a limit that isn't a number", async () => {
    const { handlers } = fake();
    expect((await handlers.transactions(req("GET", { query: "?limit=lots" }), ctx(), user)).status).toBe(400);
  });

  it("re-categorizes a transaction, or clears its category", async () => {
    const { money, handlers } = fake();
    const r = await handlers.transactionCategory(req("PUT", { params: { id: TX }, body: { categoryId: CAT2 } }), ctx(), user);
    expect(r.status).toBe(200);
    expect(money.setCategory).toHaveBeenCalledWith(HOUSEHOLD, TX, CAT2);
    await handlers.transactionCategory(req("PUT", { params: { id: TX }, body: { categoryId: null } }), ctx(), user);
    expect(money.setCategory).toHaveBeenLastCalledWith(HOUSEHOLD, TX, null);
  });

  it("refuses a missing or malformed category id, and a transaction id that isn't an id", async () => {
    const { money, handlers } = fake();
    expect((await handlers.transactionCategory(req("PUT", { params: { id: TX }, body: {} }), ctx(), user)).status).toBe(400);
    expect((await handlers.transactionCategory(req("PUT", { params: { id: TX }, body: { categoryId: "x" } }), ctx(), user)).status).toBe(400);
    expect((await handlers.transactionCategory(req("PUT", { params: { id: "nope" }, body: { categoryId: CAT } }), ctx(), user)).status).toBe(400);
    expect(money.setCategory).not.toHaveBeenCalled();
  });

  it("saves splits and passes the store's refusal on as a 400", async () => {
    const splits = [
      { categoryId: CAT, amountCents: -6000 },
      { categoryId: CAT2, amountCents: -2437 },
    ];
    const { money, handlers } = fake();
    expect((await handlers.transactionSplits(req("PUT", { params: { id: TX }, body: { splits } }), ctx(), user)).status).toBe(200);
    expect(money.setSplits).toHaveBeenCalledWith(HOUSEHOLD, TX, splits);

    const refusing = fake({ setSplits: vi.fn(async () => Promise.reject(new MoneyError("invalid", "The splits must add up"))) });
    const r = await refusing.handlers.transactionSplits(req("PUT", { params: { id: TX }, body: { splits } }), ctx(), user);
    expect(r.status).toBe(400);
    expect(r.jsonBody).toEqual({ error: "The splits must add up" });
  });

  it("refuses splits that aren't a list of category ids and whole-cent amounts", async () => {
    const { money, handlers } = fake();
    for (const body of [{}, { splits: "x" }, { splits: [{ categoryId: CAT }] }, { splits: [{ categoryId: "x", amountCents: 1 }] }, { splits: [{ categoryId: CAT, amountCents: "1" }] }]) {
      expect((await handlers.transactionSplits(req("PUT", { params: { id: TX }, body }), ctx(), user)).status).toBe(400);
    }
    expect(money.setSplits).not.toHaveBeenCalled();
  });

  it("answers 404 for a transaction that isn't in the household", async () => {
    const { handlers } = fake({ setCategory: vi.fn(async () => Promise.reject(new MoneyError("not-found", "There's no such transaction."))) });
    expect((await handlers.transactionCategory(req("PUT", { params: { id: TX }, body: { categoryId: CAT } }), ctx(), user)).status).toBe(404);
  });
});

describe("money categories and accounts", () => {
  it("lists accounts and categories", async () => {
    const { handlers } = fake();
    expect((await handlers.accounts(req("GET"), ctx(), user)).jsonBody).toEqual({ accounts: [{ id: tx.accountId, name: "Everyday Checking", mask: "0000" }] });
    expect((await handlers.categories(req("GET"), ctx(), user)).jsonBody).toEqual({ categories: [{ id: CAT, name: "Groceries", kind: "spending" }] });
  });

  it("adds and renames a category; a duplicate name is a 409", async () => {
    const { money, handlers } = fake();
    const added = await handlers.categories(req("POST", { body: { name: "Household" } }), ctx(), user);
    expect(added.status).toBe(201);
    expect(money.addCategory).toHaveBeenCalledWith(HOUSEHOLD, "Household", "spending");
    await handlers.category(req("PATCH", { params: { id: CAT }, body: { name: "Food" } }), ctx(), user);
    expect(money.updateCategory).toHaveBeenCalledWith(HOUSEHOLD, CAT, { name: "Food" });
    expect((await handlers.categories(req("POST", { body: {} }), ctx(), user)).status).toBe(400);

    const dup = fake({ addCategory: vi.fn(async () => Promise.reject(new MoneyError("conflict", "Already there"))) });
    expect((await dup.handlers.categories(req("POST", { body: { name: "Groceries" } }), ctx(), user)).status).toBe(409);
  });

  it("sets a category's kind when adding or changing it (card $6)", async () => {
    const { money, handlers } = fake();
    const added = await handlers.categories(req("POST", { body: { name: "Pay", kind: "not-spending" } }), ctx(), user);
    expect(added).toMatchObject({ status: 201, jsonBody: { name: "Pay", kind: "not-spending" } });
    expect(money.addCategory).toHaveBeenCalledWith(HOUSEHOLD, "Pay", "not-spending");

    const changed = await handlers.category(req("PATCH", { params: { id: CAT }, body: { kind: "not-spending" } }), ctx(), user);
    expect(changed).toMatchObject({ status: 200, jsonBody: { id: CAT, kind: "not-spending" } });
    expect(money.updateCategory).toHaveBeenCalledWith(HOUSEHOLD, CAT, { kind: "not-spending" });
    await handlers.category(req("PATCH", { params: { id: CAT }, body: { name: "Wages", kind: "not-spending" } }), ctx(), user);
    expect(money.updateCategory).toHaveBeenLastCalledWith(HOUSEHOLD, CAT, { name: "Wages", kind: "not-spending" });
  });

  it("refuses an unknown kind or a change with neither name nor kind", async () => {
    const { money, handlers } = fake();
    expect((await handlers.categories(req("POST", { body: { name: "Pay", kind: "income" } }), ctx(), user)).status).toBe(400);
    expect((await handlers.category(req("PATCH", { params: { id: CAT }, body: { kind: "income" } }), ctx(), user)).status).toBe(400);
    expect((await handlers.category(req("PATCH", { params: { id: CAT }, body: {} }), ctx(), user)).status).toBe(400);
    expect((await handlers.category(req("PATCH", { params: { id: CAT }, body: { name: " " } }), ctx(), user)).status).toBe(400);
    expect(money.addCategory).not.toHaveBeenCalled();
    expect(money.updateCategory).not.toHaveBeenCalled();
  });
});

describe("money rules", () => {
  const body = { field: "payee", match: "contains", pattern: "grocer", categoryId: CAT };

  it("lists, adds, updates and removes rules", async () => {
    const { money, handlers } = fake();
    expect((await handlers.rules(req("GET"), ctx(), user)).jsonBody).toEqual({ rules: [rule] });
    expect((await handlers.rules(req("POST", { body }), ctx(), user)).status).toBe(201);
    expect(money.addRule).toHaveBeenCalledWith(HOUSEHOLD, body);
    expect((await handlers.rule(req("PUT", { params: { id: RULE }, body }), ctx(), user)).status).toBe(200);
    expect(money.updateRule).toHaveBeenCalledWith(HOUSEHOLD, RULE, body);
    expect((await handlers.rule(req("DELETE", { params: { id: RULE } }), ctx(), user)).status).toBe(204);
    expect(money.removeRule).toHaveBeenCalledWith(HOUSEHOLD, RULE);
  });

  it("refuses a rule with an unknown field or match, or no pattern", async () => {
    const { money, handlers } = fake();
    for (const bad of [{ ...body, field: "amount" }, { ...body, match: "regex" }, { ...body, pattern: undefined }, { ...body, categoryId: "x" }]) {
      expect((await handlers.rules(req("POST", { body: bad }), ctx(), user)).status).toBe(400);
    }
    expect(money.addRule).not.toHaveBeenCalled();
  });

  it("reorders rules and runs them", async () => {
    const { money, handlers } = fake();
    expect((await handlers.ruleOrder(req("PUT", { body: { ruleIds: [RULE] } }), ctx(), user)).jsonBody).toEqual({ rules: [rule] });
    expect(money.reorderRules).toHaveBeenCalledWith(HOUSEHOLD, [RULE]);
    expect((await handlers.ruleOrder(req("PUT", { body: { ruleIds: ["x"] } }), ctx(), user)).status).toBe(400);
    expect((await handlers.applyRules(req("POST"), ctx(), user)).jsonBody).toEqual({ categorized: 2 });
  });
});

describe("money routes in general", () => {
  it("answers 405 for a method a route doesn't take", async () => {
    const { handlers } = fake();
    expect((await handlers.transactions(req("POST"), ctx(), user)).status).toBe(405);
    expect((await handlers.applyRules(req("GET"), ctx(), user)).status).toBe(405);
  });

  it("answers 503 without the database's message when it can't be reached", async () => {
    const { handlers } = fake({ transactions: vi.fn(async () => Promise.reject(new Error("Login failed for server sql-secret"))) });
    const context = ctx();
    vi.spyOn(context, "error").mockImplementation(() => undefined);
    const r = await handlers.transactions(req("GET"), context, user);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.jsonBody)).not.toMatch(/sql-secret/);
  });
});
