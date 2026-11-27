import { readFileSync } from "node:fs";
import { createBanks, createMoney, runMigrations, type Banks, type Money, type PlaidAccount, type PlaidTransaction } from "@kitchen/db";
import { createEmptyDatabase, testServer } from "@kitchen/db/test-database";
import type sql from "mssql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaidApiError, type PlaidChanges, type PlaidClient } from "./plaid.js";
import { syncBanks, type SyncDeps } from "./sync.js";
import type { TokenVault } from "./vault.js";

interface Page {
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/sandbox-sync.json", import.meta.url), "utf8")) as { first: Page[]; incremental: Page[] };

// Made up, shaped like a Sandbox access token. The test proves it never leaves the vault.
const ACCESS = "access-sandbox-5c2c0ec8-1111-4222-8333-444455556666";

/** Plaid's pages for one sync, joined the way the real client joins them. */
function changesFrom(pages: Page[]): PlaidChanges {
  const accounts = new Map<string, PlaidAccount>();
  for (const p of pages) for (const a of p.accounts) accounts.set(a.account_id, { account_id: a.account_id, name: a.name, mask: a.mask ?? null });
  return {
    added: pages.flatMap((p) => p.added),
    modified: pages.flatMap((p) => p.modified),
    removed: pages.flatMap((p) => p.removed.map((r) => r.transaction_id)),
    accounts: [...accounts.values()],
    nextCursor: pages.at(-1)?.next_cursor ?? "",
  };
}

/** A Plaid stand-in that answers each cursor from the fixture, or fails when told to. */
function fakePlaid(byCursor: Record<string, PlaidChanges | Error>) {
  const syncTransactions = vi.fn(async (accessToken: string, cursor: string | null) => {
    expect(accessToken).toBe(ACCESS);
    const answer = byCursor[cursor ?? "(none)"];
    if (!answer) throw new Error(`No fixture for cursor ${cursor}`);
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  });
  const client: PlaidClient = {
    environment: "sandbox",
    createLinkToken: vi.fn(),
    exchangePublicToken: vi.fn(),
    accounts: vi.fn(),
    syncTransactions,
    sandboxResetLogin: vi.fn(),
  };
  return client;
}

const first = changesFrom(fixture.first);
const incremental = changesFrom(fixture.incremental);

describe.skipIf(!testServer)("daily bank sync", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let banks: Banks;
  let money: Money;
  let household: string;
  let bankId: string;
  let logs: string[];
  let alerts: { title: string; message: string }[];

  const vault: TokenVault = {
    save: vi.fn(),
    read: vi.fn(async (name: string) => {
      expect(name).toBe("plaid-access-token-item-sandbox-1");
      return ACCESS;
    }),
    checkWritable: vi.fn(),
  };

  function deps(plaid: PlaidClient): SyncDeps {
    return {
      banks,
      money,
      plaid: () => plaid,
      vault,
      alert: async (title, message) => {
        alerts.push({ title, message });
      },
      log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    };
  }

  const payees = async () => (await money.transactions(household)).map((t) => t.plaidTransactionId).sort();
  const count = async () =>
    (await pool.request().input("h", household).query("SELECT COUNT(*) AS n FROM money_transaction WHERE household_id = @h")).recordset[0].n as number;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    banks = createBanks(pool);
    money = createMoney(pool);
  });
  afterAll(async () => {
    await drop();
  });

  beforeEach(async () => {
    logs = [];
    alerts = [];
    household = (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
    // What connecting through Link leaves: the bank, its accounts, and no cursor yet.
    await money.importPlaid(household, { accounts: first.accounts, transactions: [] });
    bankId = (
      await banks.addItem(household, {
        plaidItemId: "item-sandbox-1",
        institution: "First Platypus Bank",
        accessTokenSecret: "plaid-access-token-item-sandbox-1",
        plaidAccountIds: first.accounts.map((a) => a.account_id),
      })
    ).id;
  });

  it("first sync: saves the posted transactions, skips the pending one, and keeps Plaid's cursor", async () => {
    const summary = await syncBanks(deps(fakePlaid({ "(none)": first })), { householdId: household });

    expect(summary).toMatchObject({ banks: 1, failed: 0, added: 4, updated: 0, withdrawn: 0 });
    expect(await payees()).toEqual(["sbx-tx-climbing", "sbx-tx-coffee", "sbx-tx-grocer", "sbx-tx-pay"]);
    const grocer = (await money.transactions(household)).find((t) => t.plaidTransactionId === "sbx-tx-grocer");
    expect(grocer).toMatchObject({ amountCents: -6412, payee: "Sample Grocer", account: "Plaid Checking" });
    expect((await banks.item(household, bankId)).cursor).toBe("cursor-1");
    expect((await banks.list(household))[0]?.lastRun).toMatchObject({ ok: true, added: 4, updated: 0, withdrawn: 0 });
    expect(alerts).toEqual([]);
  });

  it("incremental sync: adds what posted, updates what changed, and reports a withdrawn transaction without deleting it", async () => {
    const plaid = fakePlaid({ "(none)": first, "cursor-1": incremental });
    await syncBanks(deps(plaid), { householdId: household });
    const summary = await syncBanks(deps(plaid), { householdId: household });

    expect(plaid.syncTransactions).toHaveBeenLastCalledWith(ACCESS, "cursor-1");
    expect(summary).toMatchObject({ failed: 0, added: 2, updated: 1, withdrawn: 1 });
    // The pending one that posted came back with a new id; the coffee the bank withdrew is kept.
    expect(await payees()).toEqual(["sbx-tx-bakery", "sbx-tx-climbing", "sbx-tx-coffee", "sbx-tx-grocer", "sbx-tx-market-posted", "sbx-tx-pay"]);
    expect((await money.transactions(household)).find((t) => t.plaidTransactionId === "sbx-tx-grocer")?.amountCents).toBe(-6612);
    const [bank] = await banks.list(household);
    expect(bank?.withdrawn.map((w) => w.plaidTransactionId)).toEqual(["sbx-tx-coffee"]);
    expect(bank?.lastRun).toMatchObject({ ok: true, added: 2, updated: 1, withdrawn: 1 });
    expect((await banks.item(household, bankId)).cursor).toBe("cursor-2");
    // Withdrawn isn't a failure, so no alert.
    expect(alerts).toEqual([]);
  });

  it("a rerun with the same changes adds no duplicates", async () => {
    // As if the cursor never moved, say because the run stopped after saving the rows.
    const plaid = fakePlaid({ "(none)": first });
    await syncBanks(deps(plaid), { householdId: household });
    await pool.request().input("b", bankId).query("UPDATE plaid_item SET sync_cursor = NULL WHERE id = @b");
    const again = await syncBanks(deps(plaid), { householdId: household });

    expect(again).toMatchObject({ added: 0, updated: 4, failed: 0 });
    expect(await count()).toBe(4);
  });

  it("a failure leaves the cursor where it was, records the run, and sends a phone alert", async () => {
    const plaid = fakePlaid({
      "(none)": first,
      "cursor-1": new PlaidApiError(400, "ITEM_LOGIN_REQUIRED", "ITEM_ERROR", "the login details of this item have changed"),
    });
    await syncBanks(deps(plaid), { householdId: household });
    const summary = await syncBanks(deps(plaid), { householdId: household });

    expect(summary).toMatchObject({ failed: 1, added: 0 });
    expect((await banks.item(household, bankId)).cursor).toBe("cursor-1");
    const [bank] = await banks.list(household);
    expect(bank).toMatchObject({ needsReconnect: true, lastRun: { ok: false, errorCode: "ITEM_LOGIN_REQUIRED" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toMatch(/bank sync failed/i);
    expect(alerts[0]?.message).toContain("First Platypus Bank");
    expect(alerts[0]?.message).toContain("ITEM_LOGIN_REQUIRED");
    expect(alerts[0]?.message).toMatch(/Reconnect/);
  });

  it("a failure while saving the rows leaves the cursor where it was too", async () => {
    const plaid = fakePlaid({ "(none)": first });
    const failingMoney: Money = { ...money, importPlaid: async () => Promise.reject(new Error("the database went away")) };
    const summary = await syncBanks({ ...deps(plaid), money: failingMoney }, { householdId: household });

    expect(summary.failed).toBe(1);
    expect((await banks.item(household, bankId)).cursor).toBeNull();
    expect(await count()).toBe(0);
    expect(alerts[0]?.message).toContain("the database went away");
  });

  it("a failure to start (Plaid isn't configured) still sends an alert", async () => {
    const summary = await syncBanks(
      {
        ...deps(fakePlaid({})),
        plaid: () => {
          throw new Error("PLAID_SECRET is not set");
        },
      },
      { householdId: household },
    );
    expect(summary.failed).toBe(1);
    expect(alerts[0]?.message).toContain("PLAID_SECRET is not set");
  });

  it("a failed alert is logged and doesn't undo the saved run", async () => {
    const plaid = fakePlaid({ "(none)": new PlaidApiError(500, "INTERNAL_SERVER_ERROR", "API_ERROR", "try again") });
    const summary = await syncBanks({ ...deps(plaid), alert: () => Promise.reject(new Error("KITCHEN_ALERT_NTFY_TOPIC is not set")) }, { householdId: household });
    expect(summary.failed).toBe(1);
    expect(logs.join("\n")).toContain("KITCHEN_ALERT_NTFY_TOPIC is not set");
    expect((await banks.list(household))[0]?.lastRun?.ok).toBe(false);
  });

  it("never puts the access token in a log, an alert or the saved run, even when an error repeats it", async () => {
    const leaky = new Error(`request failed for access_token=${ACCESS}`);
    const plaid = fakePlaid({ "(none)": first, "cursor-1": leaky });
    await syncBanks(deps(plaid), { householdId: household });
    const summary = await syncBanks(deps(plaid), { householdId: household });

    const everything = JSON.stringify({ logs, alerts, summary, banks: await banks.list(household) });
    expect(everything).not.toContain(ACCESS);
    expect(everything).not.toContain("5c2c0ec8");
    expect(alerts[0]?.message).toContain("request failed");
  });
});
