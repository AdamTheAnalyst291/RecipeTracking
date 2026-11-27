import { describe, expect, it, vi } from "vitest";
import { BanksApiError, createBanksApi } from "./api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the banks API client", () => {
  it("lists banks and asks for Link tokens, with a bank id only for Reconnect", async () => {
    const fetchFn = vi.fn(async (url: string) => json(url.endsWith("/banks") ? { environment: "sandbox", banks: [] } : { linkToken: "link-sandbox-1" }));
    const api = createBanksApi("https://api.test", async () => "tok", fetchFn);
    expect(await api.banks()).toEqual({ environment: "sandbox", banks: [] });
    expect(await api.linkToken()).toBe("link-sandbox-1");
    await api.linkToken("b1");
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]).toEqual(["https://api.test/api/money/banks", { method: "GET", headers: { Authorization: "Bearer tok" } }]);
    expect(calls[1]?.[0]).toBe("https://api.test/api/money/bank-link-token");
    expect(calls[1]?.[1]).toMatchObject({ method: "POST", body: "{}" });
    expect(calls[2]?.[1]).toMatchObject({ body: '{"bankId":"b1"}' });
  });

  it("sends Link's public token to connect, and syncs now", async () => {
    const fetchFn = vi.fn(async () => json({}));
    const api = createBanksApi("https://api.test", async () => "tok", fetchFn);
    await api.connect("public-sandbox-1", "First Platypus Bank");
    await api.syncNow();
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe("https://api.test/api/money/banks");
    expect(calls[0]?.[1]).toMatchObject({ method: "POST", body: '{"publicToken":"public-sandbox-1","institution":"First Platypus Bank"}' });
    expect(calls[1]?.[0]).toBe("https://api.test/api/money/bank-sync");
  });

  it("turns a refusal into an error with the API's message", async () => {
    const api = createBanksApi("https://api.test", async () => "tok", async () => json({ error: "Plaid refused: INVALID_PUBLIC_TOKEN: bad" }, 502));
    const e = await api.connect("x", null).catch((error: unknown) => error);
    expect(e).toBeInstanceOf(BanksApiError);
    expect((e as BanksApiError).message).toContain("INVALID_PUBLIC_TOKEN");
  });
});
