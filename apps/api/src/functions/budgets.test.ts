import { HttpRequest, InvocationContext } from "@azure/functions";
import { MoneyError, type Budgets, type MonthBudget } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createBudgetHandlers, type BudgetAccess } from "./budgets.js";

const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

// Made up; the repo is public.
const november: MonthBudget = {
  month: "2026-11",
  lines: [{ categoryId: CAT, category: "Groceries", spentCents: 41250, budgetCents: 60000, budgetFrom: "2026-10" }],
};

function fake(overrides: Partial<Record<keyof Budgets, unknown>> = {}) {
  const budgets = {
    month: vi.fn(async () => november),
    setBudget: vi.fn(async () => november),
    ...overrides,
  };
  const access: BudgetAccess = async (who) => {
    expect(who).toBe(user);
    return { budgets: budgets as unknown as Budgets, householdId: HOUSEHOLD };
  };
  return { budgets, handlers: createBudgetHandlers(access) };
}

function req(method: "GET" | "PUT" | "POST", { body, params = {}, query = "" }: { body?: unknown; params?: Record<string, string>; query?: string } = {}): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071/api/money/budgets${query}`,
    params,
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}
const ctx = () => new InvocationContext();

describe("budget routes", () => {
  it("gives a month's spend vs budget for the household", async () => {
    const { budgets, handlers } = fake();
    const r = await handlers.budgets(req("GET", { query: "?month=2026-11" }), ctx(), user);
    expect(r.status).toBe(200);
    expect(r.jsonBody).toEqual(november);
    expect(budgets.month).toHaveBeenCalledWith(HOUSEHOLD, "2026-11");
  });

  it("needs a month", async () => {
    const { budgets, handlers } = fake();
    expect((await handlers.budgets(req("GET"), ctx(), user)).status).toBe(400);
    expect(budgets.month).not.toHaveBeenCalled();
  });

  it("passes the store's refusal of a bad month on as a 400", async () => {
    const { handlers } = fake({ month: vi.fn(async () => Promise.reject(new MoneyError("invalid", "A month is written YYYY-MM."))) });
    const r = await handlers.budgets(req("GET", { query: "?month=2026-13" }), ctx(), user);
    expect(r.status).toBe(400);
    expect(r.jsonBody).toEqual({ error: "A month is written YYYY-MM." });
  });

  it("sets a category's budget from a month on, or clears it with null", async () => {
    const { budgets, handlers } = fake();
    const r = await handlers.budget(req("PUT", { params: { id: CAT }, body: { month: "2026-11", amountCents: 60000 } }), ctx(), user);
    expect(r.status).toBe(200);
    expect(r.jsonBody).toEqual(november);
    expect(budgets.setBudget).toHaveBeenCalledWith(HOUSEHOLD, CAT, "2026-11", 60000);

    await handlers.budget(req("PUT", { params: { id: CAT }, body: { month: "2026-12", amountCents: null } }), ctx(), user);
    expect(budgets.setBudget).toHaveBeenLastCalledWith(HOUSEHOLD, CAT, "2026-12", null);
  });

  it("refuses a body without a month or a whole-cent amount, and a category id that isn't an id", async () => {
    const { budgets, handlers } = fake();
    for (const body of ["not json", {}, { month: "2026-11" }, { month: "2026-11", amountCents: "600" }, { month: "2026-11", amountCents: 1.5 }, { amountCents: 100 }]) {
      expect((await handlers.budget(req("PUT", { params: { id: CAT }, body }), ctx(), user)).status).toBe(400);
    }
    expect((await handlers.budget(req("PUT", { params: { id: "nope" }, body: { month: "2026-11", amountCents: 1 } }), ctx(), user)).status).toBe(400);
    expect(budgets.setBudget).not.toHaveBeenCalled();
  });

  it("answers 404 for a category that isn't the household's", async () => {
    const { handlers } = fake({ setBudget: vi.fn(async () => Promise.reject(new MoneyError("not-found", "There's no such category."))) });
    expect((await handlers.budget(req("PUT", { params: { id: CAT }, body: { month: "2026-11", amountCents: 1 } }), ctx(), user)).status).toBe(404);
  });

  it("answers 405 for another method and 503 without saying why when the database fails", async () => {
    expect((await fake().handlers.budgets(req("POST"), ctx(), user)).status).toBe(405);
    const failing = fake({ month: vi.fn(async () => Promise.reject(new Error("Login failed for server secret.example"))) });
    const r = await failing.handlers.budgets(req("GET", { query: "?month=2026-11" }), ctx(), user);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.jsonBody)).not.toContain("secret");
  });
});
