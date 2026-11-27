import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBanks, type Banks } from "./banks.js";
import { runMigrations } from "./migrate.js";
import { MoneyError, createMoney, type Money } from "./money.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

// Made-up ids; the repo is public.
const accounts = [
  { account_id: "acc-checking-0001", name: "Everyday Checking", mask: "0000" },
  { account_id: "acc-card-0002", name: "Rewards Card", mask: "1111" },
];
const posted = (id: string, amount: number) => ({
  transaction_id: id,
  account_id: "acc-checking-0001",
  date: "2026-11-02",
  amount,
  name: "SAMPLE GROCER",
  pending: false,
});

describe.skipIf(!testServer)("banks: Plaid connections, their cursor and last run", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let banks: Banks;
  let money: Money;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    banks = createBanks(pool);
    money = createMoney(pool);
  });
  afterAll(async () => {
    await drop();
  });

  async function newHousehold(): Promise<string> {
    return (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
  }

  async function connect(h: string, plaidItemId = "item-sandbox-1") {
    await money.importPlaid(h, { accounts, transactions: [] });
    return banks.addItem(h, {
      plaidItemId,
      institution: "First Platypus Bank",
      accessTokenSecret: `plaid-access-token-${plaidItemId}`,
      plaidAccountIds: accounts.map((a) => a.account_id),
    });
  }

  it("connects a bank with its accounts and no run yet, keeping only the secret's name", async () => {
    const h = await newHousehold();
    const bank = await connect(h);
    expect(bank).toMatchObject({ institution: "First Platypus Bank", needsReconnect: false, lastRun: null, withdrawn: [] });
    expect(bank.accounts.map((a) => `${a.name} ${a.mask}`)).toEqual(["Everyday Checking 0000", "Rewards Card 1111"]);
    expect(await banks.list(h)).toEqual([bank]);

    const [item] = await banks.itemsToSync();
    expect(item).toMatchObject({ id: bank.id, householdId: h.toLowerCase(), accessTokenSecret: "plaid-access-token-item-sandbox-1", cursor: null });
  });

  it("connecting the same Plaid item again updates it instead of adding a second", async () => {
    const h = await newHousehold();
    const first = await connect(h, "item-again");
    const again = await connect(h, "item-again");
    expect(again.id).toBe(first.id);
    expect(await banks.list(h)).toHaveLength(1);
  });

  it("only lists another household's banks to that household", async () => {
    const h = await newHousehold();
    const other = await newHousehold();
    const bank = await connect(h, "item-mine");
    expect(await banks.list(other)).toEqual([]);
    await expect(banks.item(other, bank.id)).rejects.toThrow(MoneyError);
    expect((await banks.item(h, bank.id)).id).toBe(bank.id);
  });

  it("saves a good run: the cursor moves, the result is kept, and withdrawn transactions it had are recorded", async () => {
    const h = await newHousehold();
    const bank = await connect(h, "item-good-run");
    await money.importPlaid(h, { accounts, transactions: [posted("tx-kept", 12.5), posted("tx-withdrawn", 3)] });

    const withdrawn = await banks.saveRun(bank.id, {
      ok: true,
      cursor: "cursor-after-first-sync",
      added: 2,
      updated: 0,
      // tx-never-saved was pending when the bank withdrew it, so there's nothing to check.
      removedPlaidTransactionIds: ["tx-withdrawn", "tx-never-saved"],
      message: "OK",
    });
    expect(withdrawn).toBe(1);

    const [listed] = await banks.list(h);
    expect(listed?.lastRun).toMatchObject({ ok: true, added: 2, updated: 0, withdrawn: 1, message: "OK", errorCode: null });
    expect(listed?.withdrawn).toEqual([expect.objectContaining({ plaidTransactionId: "tx-withdrawn", amountCents: -300, payee: "SAMPLE GROCER", date: "2026-11-02" })]);
    expect((await banks.item(h, bank.id)).cursor).toBe("cursor-after-first-sync");

    // Reported once, even when Plaid says it again.
    expect(await banks.saveRun(bank.id, { ok: true, cursor: "c2", added: 0, updated: 0, removedPlaidTransactionIds: ["tx-withdrawn"], message: "OK" })).toBe(0);
    expect((await banks.list(h))[0]?.withdrawn).toHaveLength(1);
  });

  it("saves a failed run without moving the cursor, and marks the bank for reconnecting when asked", async () => {
    const h = await newHousehold();
    const bank = await connect(h, "item-failed-run");
    await banks.saveRun(bank.id, { ok: true, cursor: "good-cursor", added: 0, updated: 0, removedPlaidTransactionIds: [], message: "OK" });

    await banks.saveRun(bank.id, { ok: false, errorCode: "ITEM_LOGIN_REQUIRED", needsReconnect: true, message: "ITEM_LOGIN_REQUIRED: the login details changed" });
    expect((await banks.item(h, bank.id)).cursor).toBe("good-cursor");
    const [listed] = await banks.list(h);
    expect(listed).toMatchObject({ needsReconnect: true, lastRun: { ok: false, errorCode: "ITEM_LOGIN_REQUIRED", added: 0, updated: 0, withdrawn: 0 } });

    // The next good run clears it.
    await banks.saveRun(bank.id, { ok: true, cursor: "next", added: 1, updated: 0, removedPlaidTransactionIds: [], message: "OK" });
    expect((await banks.list(h))[0]).toMatchObject({ needsReconnect: false, lastRun: { ok: true } });
  });

  it("lists every household's banks for the daily job, or one household's", async () => {
    const a = await newHousehold();
    const b = await newHousehold();
    await connect(a, "item-job-a");
    await connect(b, "item-job-b");
    const all = (await banks.itemsToSync()).map((i) => i.plaidItemId);
    expect(all).toEqual(expect.arrayContaining(["item-job-a", "item-job-b"]));
    expect((await banks.itemsToSync(a)).map((i) => i.plaidItemId)).toEqual(["item-job-a"]);
  });
});
