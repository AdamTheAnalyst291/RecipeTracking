import { describe, expect, it, vi } from "vitest";
import { MoneyApiError } from "./api.js";
import { createBudgetApi } from "./budget-api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the budget API client", () => {
  it("reads a month and puts a budget change as JSON, with the token", async () => {
    const fetchFn = vi.fn(async () => json({ month: "2026-11", lines: [] }));
    const api = createBudgetApi("https://api.test", async () => "tok", fetchFn);
    expect(await api.month("2026-11")).toEqual({ month: "2026-11", lines: [] });
    await api.setBudget("c1", "2026-11", 60000);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]).toEqual(["https://api.test/api/money/budgets?month=2026-11", { method: "GET", headers: { Authorization: "Bearer tok" } }]);
    expect(calls[1]?.[0]).toBe("https://api.test/api/money/budgets/c1");
    expect(calls[1]?.[1]).toMatchObject({ method: "PUT", body: '{"month":"2026-11","amountCents":60000}' });
  });

  it("turns a refusal into an error with the API's message", async () => {
    const api = createBudgetApi("https://api.test", async () => "tok", async () => json({ error: "There's no such category." }, 404));
    const e = await api.setBudget("c1", "2026-11", null).catch((error: unknown) => error);
    expect(e).toBeInstanceOf(MoneyApiError);
    expect((e as MoneyApiError).status).toBe(404);
    expect((e as MoneyApiError).message).toBe("There's no such category.");
  });
});
