import { HttpRequest, InvocationContext } from "@azure/functions";
import { MoneyError, type Bank, type BankItem, type Banks, type Money } from "@kitchen/db";
import { describe, expect, it, vi } from "vitest";
import type { SignedInUser } from "../auth.js";
import { PlaidApiError, PlaidConfigError, type PlaidClient } from "../bank/plaid.js";
import type { TokenVault } from "../bank/vault.js";
import { createBankHandlers, type BankAccess } from "./banks.js";

// Made up, shaped like Plaid Sandbox's; the repo is public and no test calls Plaid.
const HOUSEHOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BANK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCESS = "access-sandbox-9f8e7d6c-1111-4222-8333-444455556666";
const user: SignedInUser = { objectId: "33333333-3333-4333-8333-333333333333", name: "Test User", household: { id: "home", memberObjectIds: [] } };

const bank: Bank = {
  id: BANK,
  institution: "First Platypus Bank",
  accounts: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Plaid Checking", mask: "0000" }],
  needsReconnect: false,
  lastRun: null,
  withdrawn: [],
};
const item: BankItem = { id: BANK, householdId: HOUSEHOLD, plaidItemId: "item-sandbox-1", institution: "First Platypus Bank", accessTokenSecret: "plaid-access-token-item-sandbox-1", cursor: null };

function setup(options: { environment?: "sandbox" | "production"; plaid?: Partial<PlaidClient>; vault?: Partial<TokenVault>; plaidMissing?: boolean } = {}) {
  const banks = {
    addItem: vi.fn(async () => bank),
    list: vi.fn(async () => [bank]),
    item: vi.fn(async (_h: string, id: string) => {
      if (id !== BANK) throw new MoneyError("not-found", "There's no such bank.");
      return item;
    }),
    itemsToSync: vi.fn(async () => []),
    saveRun: vi.fn(async () => 0),
  } satisfies Banks;
  const money = { importPlaid: vi.fn(async () => ({ added: 0, updated: 0, skippedPending: 0, skippedUnknownAccount: 0, splitsCleared: 0, categorizedByRule: 0 })) };
  const plaid: PlaidClient = {
    environment: options.environment ?? "sandbox",
    createLinkToken: vi.fn(async () => "link-sandbox-token"),
    exchangePublicToken: vi.fn(async () => ({ itemId: "item-sandbox-1", accessToken: ACCESS })),
    accounts: vi.fn(async () => [{ account_id: "sbx-acc-checking", name: "Plaid Checking", mask: "0000" }]),
    syncTransactions: vi.fn(),
    sandboxResetLogin: vi.fn(async () => undefined),
    ...options.plaid,
  };
  const vault: TokenVault = {
    save: vi.fn(async () => undefined),
    read: vi.fn(async () => ACCESS),
    checkWritable: vi.fn(async () => undefined),
    ...options.vault,
  };
  const access: BankAccess = async (who) => {
    expect(who).toBe(user);
    return { banks, money: money as unknown as Money, householdId: HOUSEHOLD };
  };
  const logs: string[] = [];
  const handlers = createBankHandlers(access, {
    plaid: () => {
      if (options.plaidMissing) throw new PlaidConfigError("PLAID_SECRET is not set");
      return plaid;
    },
    vault,
    alert: vi.fn(async () => undefined),
  });
  const ctx = () => {
    const c = new InvocationContext();
    c.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    c.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    c.warn = c.error;
    return c;
  };
  return { banks, money, plaid, vault, handlers, ctx, logs };
}

function req(method: "GET" | "POST", { body, params = {} }: { body?: unknown; params?: Record<string, string> } = {}): HttpRequest {
  return new HttpRequest({
    method,
    url: "http://localhost:7071/api/money/banks",
    params,
    ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "content-type": "application/json" } }),
  });
}

describe("connected banks", () => {
  it("lists the household's banks and which Plaid environment this is", async () => {
    const { handlers, ctx, banks } = setup();
    const res = await handlers.banks(req("GET"), ctx(), user);
    expect(res).toMatchObject({ status: 200, jsonBody: { environment: "sandbox", banks: [bank] } });
    expect(banks.list).toHaveBeenCalledWith(HOUSEHOLD);
  });

  it("says Plaid isn't set up when its settings are missing, without naming values", async () => {
    const { handlers, ctx } = setup({ plaidMissing: true });
    const res = await handlers.banks(req("GET"), ctx(), user);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.jsonBody)).toMatch(/aren't set up/);
  });
});

describe("Plaid Link", () => {
  it("makes a Link token for a new bank after checking the vault can store its token", async () => {
    const { handlers, ctx, plaid, vault } = setup();
    const res = await handlers.linkToken(req("POST", { body: {} }), ctx(), user);
    expect(res).toMatchObject({ status: 200, jsonBody: { linkToken: "link-sandbox-token" } });
    expect(vault.checkWritable).toHaveBeenCalled();
    expect(plaid.createLinkToken).toHaveBeenCalledWith({ userId: HOUSEHOLD });
  });

  it("doesn't start a new connection when the vault can't be written, so no Plaid slot is wasted", async () => {
    const { handlers, ctx, plaid } = setup({ vault: { checkWritable: vi.fn(async () => Promise.reject(new Error("Forbidden: no secrets/set permission"))) } });
    const res = await handlers.linkToken(req("POST", { body: {} }), ctx(), user);
    expect(res.status).toBe(503);
    expect(plaid.createLinkToken).not.toHaveBeenCalled();
  });

  it("makes an update-mode Link token for Reconnect from the bank's stored token, without returning it", async () => {
    const { handlers, ctx, plaid, vault } = setup();
    const res = await handlers.linkToken(req("POST", { body: { bankId: BANK } }), ctx(), user);
    expect(res).toMatchObject({ status: 200, jsonBody: { linkToken: "link-sandbox-token" } });
    expect(vault.read).toHaveBeenCalledWith("plaid-access-token-item-sandbox-1");
    expect(plaid.createLinkToken).toHaveBeenCalledWith({ userId: HOUSEHOLD, accessToken: ACCESS });
    expect(JSON.stringify(res)).not.toContain(ACCESS);
  });

  it("answers 404 for Reconnect on a bank that isn't the household's, and 400 for a bank id that isn't an id", async () => {
    const { handlers, ctx } = setup();
    expect((await handlers.linkToken(req("POST", { body: { bankId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } }), ctx(), user)).status).toBe(404);
    expect((await handlers.linkToken(req("POST", { body: { bankId: "nope" } }), ctx(), user)).status).toBe(400);
  });

  it("exchanges the public token, stores the access token in Key Vault only, and saves the bank and its accounts", async () => {
    const { handlers, ctx, vault, banks, money, plaid, logs } = setup();
    const res = await handlers.banks(req("POST", { body: { publicToken: "public-sandbox-1", institution: "First Platypus Bank" } }), ctx(), user);

    expect(res).toMatchObject({ status: 201, jsonBody: bank });
    expect(plaid.exchangePublicToken).toHaveBeenCalledWith("public-sandbox-1");
    expect(vault.save).toHaveBeenCalledWith("plaid-access-token-item-sandbox-1", ACCESS);
    expect(money.importPlaid).toHaveBeenCalledWith(HOUSEHOLD, { accounts: [{ account_id: "sbx-acc-checking", name: "Plaid Checking", mask: "0000" }], transactions: [] });
    expect(banks.addItem).toHaveBeenCalledWith(HOUSEHOLD, {
      plaidItemId: "item-sandbox-1",
      institution: "First Platypus Bank",
      accessTokenSecret: "plaid-access-token-item-sandbox-1",
      plaidAccountIds: ["sbx-acc-checking"],
    });
    // The token goes to the vault and nowhere else.
    expect(JSON.stringify({ res, logs, saved: banks.addItem.mock.calls, imported: money.importPlaid.mock.calls })).not.toContain(ACCESS);
  });

  it("refuses a body without a public token", async () => {
    const { handlers, ctx, plaid } = setup();
    expect((await handlers.banks(req("POST", { body: {} }), ctx(), user)).status).toBe(400);
    expect((await handlers.banks(req("POST", { body: "not json" }), ctx(), user)).status).toBe(400);
    expect(plaid.exchangePublicToken).not.toHaveBeenCalled();
  });

  it("never puts the access token in a response or log when storing it fails, even if the error repeats it", async () => {
    const { handlers, ctx, logs, banks } = setup({ vault: { save: vi.fn(async () => Promise.reject(new Error(`could not set secret to ${ACCESS}`))) } });
    const res = await handlers.banks(req("POST", { body: { publicToken: "public-sandbox-1" } }), ctx(), user);
    expect(res.status).toBe(503);
    expect(banks.addItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ res, logs })).not.toContain(ACCESS);
    expect(logs.join("\n")).toContain("could not set secret");
  });

  it("passes on Plaid's error code when Plaid refuses", async () => {
    const { handlers, ctx } = setup({ plaid: { exchangePublicToken: vi.fn(async () => Promise.reject(new PlaidApiError(400, "INVALID_PUBLIC_TOKEN", "INVALID_INPUT", "bad token"))) } });
    const res = await handlers.banks(req("POST", { body: { publicToken: "public-sandbox-1" } }), ctx(), user);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.jsonBody)).toContain("INVALID_PUBLIC_TOKEN");
  });
});

describe("syncing now and Sandbox tools", () => {
  it("syncs the household's banks now", async () => {
    const { handlers, ctx, banks } = setup();
    const res = await handlers.sync(req("POST"), ctx(), user);
    expect(res).toMatchObject({ status: 200, jsonBody: { banks: 0, failed: 0 } });
    expect(banks.itemsToSync).toHaveBeenCalledWith(HOUSEHOLD);
  });

  it("resets a Sandbox login so a failure and Reconnect can be tried", async () => {
    const { handlers, ctx, plaid } = setup();
    const res = await handlers.sandboxResetLogin(req("POST", { params: { id: BANK } }), ctx(), user);
    expect(res.status).toBe(204);
    expect(plaid.sandboxResetLogin).toHaveBeenCalledWith(ACCESS);
  });

  it("has no Sandbox reset in production", async () => {
    const { handlers, ctx, plaid } = setup({ environment: "production" });
    expect((await handlers.sandboxResetLogin(req("POST", { params: { id: BANK } }), ctx(), user)).status).toBe(404);
    expect(plaid.sandboxResetLogin).not.toHaveBeenCalled();
  });

  it("answers 405 for a method a route doesn't take", async () => {
    const { handlers, ctx } = setup();
    expect((await handlers.linkToken(req("GET"), ctx(), user)).status).toBe(405);
  });
});
