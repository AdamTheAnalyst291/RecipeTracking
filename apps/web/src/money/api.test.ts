import { describe, expect, it, vi } from "vitest";
import { MoneyApiError, createMoneyApi } from "./api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the money API client", () => {
  it("sends the token and reads the transactions, optionally only uncategorized", async () => {
    const fetchFn = vi.fn(async () => json({ transactions: [] }));
    const api = createMoneyApi("https://api.test", async () => "tok", fetchFn);
    expect(await api.transactions()).toEqual([]);
    await api.transactions({ uncategorized: true });
    expect(fetchFn).toHaveBeenNthCalledWith(1, "https://api.test/api/money/transactions", { method: "GET", headers: { Authorization: "Bearer tok" } });
    expect(fetchFn).toHaveBeenNthCalledWith(2, "https://api.test/api/money/transactions?uncategorized=true", expect.anything());
  });

  it("puts a category choice and splits as JSON", async () => {
    const fetchFn = vi.fn(async () => json({}));
    const api = createMoneyApi("https://api.test", async () => "tok", fetchFn);
    await api.setCategory("t1", null);
    await api.setSplits("t1", [{ categoryId: "c1", amountCents: -100 }]);
    await api.reorderRules(["r2", "r1"]).catch(() => undefined);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe("https://api.test/api/money/transactions/t1/category");
    expect(calls[0]?.[1]).toMatchObject({ method: "PUT", body: '{"categoryId":null}' });
    expect(calls[1]?.[1]).toMatchObject({ method: "PUT", body: '{"splits":[{"categoryId":"c1","amountCents":-100}]}' });
    expect(calls[2]?.[0]).toBe("https://api.test/api/money/rule-order");
  });

  it("adds a category with its kind and patches a category's kind", async () => {
    const fetchFn = vi.fn(async () => json({}));
    const api = createMoneyApi("https://api.test", async () => "tok", fetchFn);
    await api.addCategory("Pay", "not-spending");
    await api.setCategoryKind("c1", "spending");
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]).toEqual(["https://api.test/api/money/categories", expect.objectContaining({ method: "POST", body: '{"name":"Pay","kind":"not-spending"}' })]);
    expect(calls[1]).toEqual(["https://api.test/api/money/categories/c1", expect.objectContaining({ method: "PATCH", body: '{"kind":"spending"}' })]);
  });

  it("turns a refusal into an error with the API's message", async () => {
    const api = createMoneyApi("https://api.test", async () => "tok", async () => json({ error: "The splits must add up" }, 400));
    const e = await api.setSplits("t1", []).catch((error: unknown) => error);
    expect(e).toBeInstanceOf(MoneyApiError);
    expect((e as MoneyApiError).status).toBe(400);
    expect((e as MoneyApiError).message).toBe("The splits must add up");
  });
});
