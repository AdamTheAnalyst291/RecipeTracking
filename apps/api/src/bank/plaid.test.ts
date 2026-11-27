import { describe, expect, it, vi } from "vitest";
import { createPlaidClient, plaidConfigFrom, PlaidApiError } from "./plaid.js";

// Made-up keys and ids shaped like Plaid Sandbox's; the repo is public, and no test calls Plaid.
const config = { environment: "sandbox" as const, clientId: "test-client-id", secret: "test-sandbox-secret" };
const ACCESS = "access-sandbox-00000000-0000-4000-8000-000000000000";

type Call = { url: string; body: Record<string, unknown> };

/** A stand-in for Plaid's API: answers each path from `replies`, recording what was sent. */
function fakePlaid(replies: Record<string, ((body: Record<string, unknown>) => { status?: number; json: unknown })[]>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    const reply = replies[path]?.shift();
    if (!reply) throw new Error(`No reply for ${path}`);
    const { status = 200, json } = reply(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
  return { calls, client: createPlaidClient(config, fetchFn) };
}

const tx = (id: string) => ({ transaction_id: id, account_id: "acc-1", date: "2026-11-02", amount: 1, name: "X", pending: false });

describe("plaidConfigFrom", () => {
  it("reads the environment and keys from configuration", () => {
    expect(plaidConfigFrom({ PLAID_ENV: "sandbox", PLAID_CLIENT_ID: " id ", PLAID_SECRET: "s" })).toEqual({ environment: "sandbox", clientId: "id", secret: "s" });
    expect(plaidConfigFrom({ PLAID_ENV: "production", PLAID_CLIENT_ID: "id", PLAID_SECRET: "s" }).environment).toBe("production");
  });

  it("refuses a missing key or an environment that isn't sandbox or production, without echoing the secret", () => {
    expect(() => plaidConfigFrom({ PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "id" })).toThrow(/PLAID_SECRET/);
    expect(() => plaidConfigFrom({ PLAID_ENV: "development", PLAID_CLIENT_ID: "id", PLAID_SECRET: "very-secret" })).toThrow(/sandbox or production/);
    expect(() => plaidConfigFrom({ PLAID_ENV: "development", PLAID_CLIENT_ID: "id", PLAID_SECRET: "very-secret" })).not.toThrow(/very-secret/);
  });
});

describe("Plaid client", () => {
  it("creates a Link token for transactions, or for update mode with an access token", async () => {
    const { calls, client } = fakePlaid({
      "/link/token/create": [() => ({ json: { link_token: "link-sandbox-new" } }), () => ({ json: { link_token: "link-sandbox-update" } })],
    });
    expect(await client.createLinkToken({ userId: "household-1" })).toBe("link-sandbox-new");
    expect(calls[0]?.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0]?.body).toMatchObject({
      client_id: "test-client-id",
      secret: "test-sandbox-secret",
      products: ["transactions"],
      country_codes: ["US"],
      user: { client_user_id: "household-1" },
    });

    expect(await client.createLinkToken({ userId: "household-1", accessToken: ACCESS })).toBe("link-sandbox-update");
    expect(calls[1]?.body).toMatchObject({ access_token: ACCESS });
    expect(calls[1]?.body).not.toHaveProperty("products");
  });

  it("exchanges a public token for the item and its access token, and reads the accounts", async () => {
    const { client } = fakePlaid({
      "/item/public_token/exchange": [() => ({ json: { access_token: ACCESS, item_id: "item-sandbox-1" } })],
      "/accounts/get": [() => ({ json: { accounts: [{ account_id: "acc-1", name: "Plaid Checking", mask: "0000", type: "depository" }] } })],
    });
    expect(await client.exchangePublicToken("public-sandbox-1")).toEqual({ itemId: "item-sandbox-1", accessToken: ACCESS });
    expect(await client.accounts(ACCESS)).toEqual([{ account_id: "acc-1", name: "Plaid Checking", mask: "0000" }]);
  });

  it("pages through /transactions/sync until has_more is false", async () => {
    const { calls, client } = fakePlaid({
      "/transactions/sync": [
        () => ({ json: { added: [tx("t1")], modified: [], removed: [], accounts: [{ account_id: "acc-1", name: "Plaid Checking", mask: "0000" }], next_cursor: "c1", has_more: true } }),
        () => ({ json: { added: [tx("t2")], modified: [tx("t0")], removed: [{ transaction_id: "t-gone" }], accounts: [], next_cursor: "c2", has_more: false } }),
      ],
    });
    const changes = await client.syncTransactions(ACCESS, "c0");
    expect(changes.added.map((t) => t.transaction_id)).toEqual(["t1", "t2"]);
    expect(changes.modified.map((t) => t.transaction_id)).toEqual(["t0"]);
    expect(changes.removed).toEqual(["t-gone"]);
    expect(changes.accounts).toEqual([{ account_id: "acc-1", name: "Plaid Checking", mask: "0000" }]);
    expect(changes.nextCursor).toBe("c2");
    expect(calls.map((c) => c.body.cursor)).toEqual(["c0", "c1"]);
  });

  it("starts the first sync with no cursor", async () => {
    const { calls, client } = fakePlaid({
      "/transactions/sync": [() => ({ json: { added: [], modified: [], removed: [], accounts: [], next_cursor: "c1", has_more: false } })],
    });
    await client.syncTransactions(ACCESS, null);
    expect(calls[0]?.body).not.toHaveProperty("cursor");
  });

  it("restarts from the original cursor when the data changed while paging", async () => {
    const mutation = { status: 400, json: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "changed" } };
    const { calls, client } = fakePlaid({
      "/transactions/sync": [
        () => ({ json: { added: [tx("t1")], modified: [], removed: [], accounts: [], next_cursor: "c1", has_more: true } }),
        () => mutation,
        () => ({ json: { added: [tx("t1"), tx("t2")], modified: [], removed: [], accounts: [], next_cursor: "c9", has_more: false } }),
      ],
    });
    const changes = await client.syncTransactions(ACCESS, "c0");
    expect(changes.added.map((t) => t.transaction_id)).toEqual(["t1", "t2"]);
    expect(calls.map((c) => c.body.cursor)).toEqual(["c0", "c1", "c0"]);
  });

  it("turns Plaid's error body into a PlaidApiError with its code, never with what was sent", async () => {
    const { client } = fakePlaid({
      "/transactions/sync": [
        () => ({ status: 400, json: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed" } }),
      ],
    });
    const error = await client.syncTransactions(ACCESS, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlaidApiError);
    expect(error).toMatchObject({ code: "ITEM_LOGIN_REQUIRED", status: 400 });
    expect(String((error as Error).message)).not.toContain(ACCESS);
    expect(String((error as Error).message)).not.toContain("test-sandbox-secret");
  });

  it("resets a Sandbox login so a failure and Reconnect can be tried, and refuses in production", async () => {
    const { calls, client } = fakePlaid({ "/sandbox/item/reset_login": [() => ({ json: { reset_login: true } })] });
    await client.sandboxResetLogin(ACCESS);
    expect(calls[0]?.url).toBe("https://sandbox.plaid.com/sandbox/item/reset_login");

    const production = createPlaidClient({ ...config, environment: "production" }, vi.fn());
    await expect(production.sandboxResetLogin(ACCESS)).rejects.toThrow(/Sandbox/);
  });
});
