import { readFileSync } from "node:fs";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { MoneyError, createMoney, type Money, type PlaidImport, type Transaction } from "./money.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

// Made-up accounts and transactions; the repo is public.
const fixture = JSON.parse(readFileSync(new URL("../test-fixtures/plaid-transactions.json", import.meta.url), "utf8")) as PlaidImport;
const sample = (): PlaidImport => structuredClone({ accounts: fixture.accounts, transactions: fixture.transactions });

describe.skipIf(!testServer)("money: transactions, categories, splits and rules", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let money: Money;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    money = createMoney(pool);
  });
  afterAll(async () => {
    await drop();
  });

  async function newHousehold(): Promise<string> {
    return (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id;
  }
  async function rejection(promise: Promise<unknown>): Promise<MoneyError> {
    const e = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(e instanceof MoneyError)) throw new Error(`Expected a MoneyError, got ${String(e)}`);
    return e;
  }
  const byPlaid = (txs: Transaction[], id: string) => {
    const tx = txs.find((t) => t.plaidTransactionId === id);
    if (!tx) throw new Error(`No transaction ${id}`);
    return tx;
  };
  const count = async (h: string) =>
    (await pool.request().input("h", h).query("SELECT COUNT(*) AS n FROM money_transaction WHERE household_id = @h")).recordset[0].n as number;

  describe("importing Plaid-shaped transactions", () => {
    it("adds accounts and posted transactions in cents, money out negative, and skips pending ones", async () => {
      const h = await newHousehold();
      const report = await money.importPlaid(h, sample());

      expect(report).toMatchObject({ added: 5, updated: 0, skippedPending: 1, skippedUnknownAccount: 0 });
      const accounts = await money.accounts(h);
      expect(accounts.map((a) => `${a.name} ${a.mask}`)).toEqual(["Everyday Checking 0000", "Rewards Card 1111"]);

      const txs = await money.transactions(h);
      expect(txs.map((t) => t.plaidTransactionId)).toEqual(["tx-0005", "tx-0004", "tx-0003", "tx-0002", "tx-0001"]);
      const grocer = byPlaid(txs, "tx-0001");
      expect(grocer).toMatchObject({ date: "2026-11-02", amountCents: -8437, payee: "Sample Grocer", account: "Everyday Checking", categoryId: null });
      expect(byPlaid(txs, "tx-0004").amountCents).toBe(150000);
    });

    it("updates rather than duplicates when the same Plaid id comes again", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const again = sample();
      again.transactions[0]!.amount = 90.01;
      again.transactions[0]!.merchant_name = "Sample Grocer Renamed";

      const report = await money.importPlaid(h, again);

      expect(report).toMatchObject({ added: 0, updated: 5 });
      expect(await count(h)).toBe(5);
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      expect(tx.amountCents).toBe(-9001);
      expect(tx.payee).toBe("Sample Grocer Renamed");
      expect((await money.accounts(h)).length).toBe(2);
    });

    it("treats a Plaid id repeated within one import as one transaction", async () => {
      const h = await newHousehold();
      const input = sample();
      input.transactions.push({ ...input.transactions[0]!, amount: 1 });
      const report = await money.importPlaid(h, input);
      expect(await count(h)).toBe(5);
      expect(report.added + report.updated).toBe(6);
      expect(byPlaid(await money.transactions(h), "tx-0001").amountCents).toBe(-100);
    });

    it("keeps the same Plaid id apart in two households", async () => {
      const a = await newHousehold();
      const b = await newHousehold();
      await money.importPlaid(a, sample());
      await money.importPlaid(b, sample());
      expect(await count(a)).toBe(5);
      expect(await count(b)).toBe(5);
    });

    it("skips a transaction for an account it doesn't know", async () => {
      const h = await newHousehold();
      const input = sample();
      input.accounts = input.accounts.slice(0, 1);
      const report = await money.importPlaid(h, input);
      expect(report).toMatchObject({ added: 3, skippedUnknownAccount: 2 });
    });
  });

  describe("categories and re-categorizing", () => {
    it("adds and renames categories, refusing a duplicate name in the household", async () => {
      const h = await newHousehold();
      const groceries = await money.addCategory(h, " Groceries ");
      expect(groceries.name).toBe("Groceries");
      expect((await rejection(money.addCategory(h, "groceries"))).code).toBe("conflict");
      expect((await money.renameCategory(h, groceries.id, "Food")).name).toBe("Food");
      expect((await money.categories(h)).map((c) => c.name)).toEqual(["Food"]);
      expect((await money.categories(await newHousehold())).length).toBe(0);
    });

    it("gives a category a kind: spending by default, or not spending for transfers and income", async () => {
      const h = await newHousehold();
      const groceries = await money.addCategory(h, "Groceries");
      const pay = await money.addCategory(h, "Pay", "not-spending");
      expect(groceries.kind).toBe("spending");
      expect(pay.kind).toBe("not-spending");

      const transfers = await money.addCategory(h, "Transfers");
      expect(await money.updateCategory(h, transfers.id, { kind: "not-spending" })).toEqual({ id: transfers.id, name: "Transfers", kind: "not-spending" });
      expect(await money.updateCategory(h, transfers.id, { name: "Moving money" })).toMatchObject({ name: "Moving money", kind: "not-spending" });
      expect(await money.updateCategory(h, pay.id, { name: "Salary", kind: "spending" })).toMatchObject({ name: "Salary", kind: "spending" });
      expect(await money.renameCategory(h, groceries.id, "Food")).toMatchObject({ name: "Food", kind: "spending" });
      expect((await money.categories(h)).map((c) => `${c.name} ${c.kind}`)).toEqual(["Food spending", "Moving money not-spending", "Salary spending"]);
    });

    it("refuses an unknown kind, an empty change, a clashing name, and another household's category", async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      const mine = await money.addCategory(h, "Mine");
      await money.addCategory(h, "Also mine");
      const theirs = await money.addCategory(other, "Theirs");
      expect((await rejection(money.addCategory(h, "Odd", "income" as never))).code).toBe("invalid");
      expect((await rejection(money.updateCategory(h, mine.id, { kind: "income" as never }))).code).toBe("invalid");
      expect((await rejection(money.updateCategory(h, mine.id, {}))).code).toBe("invalid");
      expect((await rejection(money.updateCategory(h, mine.id, { name: "also mine", kind: "not-spending" }))).code).toBe("conflict");
      expect((await rejection(money.updateCategory(h, theirs.id, { kind: "not-spending" }))).code).toBe("not-found");
      expect(await money.categories(h)).toEqual([expect.objectContaining({ name: "Also mine", kind: "spending" }), expect.objectContaining({ name: "Mine", kind: "spending" })]);
      expect((await money.categories(other))[0]).toMatchObject({ kind: "spending" });
    });

    it("sets a category by hand, changes it and clears it", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const groceries = await money.addCategory(h, "Groceries");
      const eatingOut = await money.addCategory(h, "Eating out");
      const tx = byPlaid(await money.transactions(h), "tx-0002");

      expect(await money.setCategory(h, tx.id, groceries.id)).toMatchObject({ categoryId: groceries.id, category: "Groceries", categorySource: "manual" });
      expect(await money.setCategory(h, tx.id, eatingOut.id)).toMatchObject({ category: "Eating out" });
      expect(await money.setCategory(h, tx.id, null)).toMatchObject({ categoryId: null, categorySource: null });
      expect((await money.transactions(h, { uncategorized: true })).map((t) => t.id)).toContain(tx.id);
    });

    it("won't use another household's category or touch another household's transaction", async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      await money.importPlaid(h, sample());
      await money.importPlaid(other, sample());
      const theirs = await money.addCategory(other, "Theirs");
      const mine = await money.addCategory(h, "Mine");
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      const theirTx = byPlaid(await money.transactions(other), "tx-0001");

      expect((await rejection(money.setCategory(h, tx.id, theirs.id))).code).toBe("not-found");
      expect((await rejection(money.setCategory(h, theirTx.id, mine.id))).code).toBe("not-found");
      expect((await rejection(money.setSplits(h, theirTx.id, []))).code).toBe("not-found");
      expect((await rejection(money.renameCategory(h, theirs.id, "x"))).code).toBe("not-found");
    });
  });

  describe("splits", () => {
    it("splits a transaction across categories when the parts add up, and un-splits it", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const groceries = await money.addCategory(h, "Groceries");
      const household = await money.addCategory(h, "Household");
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      await money.setCategory(h, tx.id, groceries.id);

      const split = await money.setSplits(h, tx.id, [
        { categoryId: groceries.id, amountCents: -6000 },
        { categoryId: household.id, amountCents: -2437 },
      ]);
      expect(split.categoryId).toBeNull();
      expect(split.splits.map((s) => `${s.category} ${s.amountCents}`)).toEqual(["Groceries -6000", "Household -2437"]);
      expect(split.splits.reduce((sum, s) => sum + s.amountCents, 0)).toBe(tx.amountCents);
      expect((await money.transactions(h, { uncategorized: true })).map((t) => t.id)).not.toContain(tx.id);

      const unsplit = await money.setSplits(h, tx.id, []);
      expect(unsplit.splits).toEqual([]);
    });

    it("refuses splits that don't add up and keeps the old ones", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const a = await money.addCategory(h, "A");
      const b = await money.addCategory(h, "B");
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      await money.setSplits(h, tx.id, [
        { categoryId: a.id, amountCents: -8000 },
        { categoryId: b.id, amountCents: -437 },
      ]);

      const e = await rejection(
        money.setSplits(h, tx.id, [
          { categoryId: a.id, amountCents: -8000 },
          { categoryId: b.id, amountCents: -400 },
        ]),
      );
      expect(e.code).toBe("invalid");
      expect(byPlaid(await money.transactions(h), "tx-0001").splits.map((s) => s.amountCents)).toEqual([-8000, -437]);
    });

    it("setting one category replaces the splits", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const a = await money.addCategory(h, "A");
      const b = await money.addCategory(h, "B");
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      await money.setSplits(h, tx.id, [
        { categoryId: a.id, amountCents: -8000 },
        { categoryId: b.id, amountCents: -437 },
      ]);
      const after = await money.setCategory(h, tx.id, b.id);
      expect(after).toMatchObject({ category: "B", splits: [] });
    });

    it("clears splits when Plaid changes the amount, so they never stop adding up", async () => {
      const h = await newHousehold();
      await money.importPlaid(h, sample());
      const a = await money.addCategory(h, "A");
      const b = await money.addCategory(h, "B");
      const tx = byPlaid(await money.transactions(h), "tx-0001");
      await money.setSplits(h, tx.id, [
        { categoryId: a.id, amountCents: -8000 },
        { categoryId: b.id, amountCents: -437 },
      ]);

      const same = await money.importPlaid(h, sample());
      expect(same.splitsCleared).toBe(0);
      const changed = sample();
      changed.transactions[0]!.amount = 85;
      expect((await money.importPlaid(h, changed)).splitsCleared).toBe(1);
      expect(byPlaid(await money.transactions(h), "tx-0001")).toMatchObject({ amountCents: -8500, splits: [], categoryId: null });
    });
  });

  describe("rules", () => {
    async function setUp() {
      const h = await newHousehold();
      const groceries = await money.addCategory(h, "Groceries");
      const eatingOut = await money.addCategory(h, "Eating out");
      const fun = await money.addCategory(h, "Fun");
      return { h, groceries, eatingOut, fun };
    }

    it("categorizes imported transactions by the first matching rule, in order", async () => {
      const { h, groceries, eatingOut, fun } = await setUp();
      await money.addRule(h, { field: "payee", match: "equals", pattern: "sample grocer", categoryId: groceries.id });
      await money.addRule(h, { field: "description", match: "contains", pattern: "freshmart", categoryId: groceries.id });
      await money.addRule(h, { field: "payee", match: "contains", pattern: "bakery", categoryId: eatingOut.id });
      // Never reached for the grocer: the first rule wins.
      await money.addRule(h, { field: "description", match: "contains", pattern: "grocer", categoryId: fun.id });

      const report = await money.importPlaid(h, sample());
      expect(report.categorizedByRule).toBe(3);
      const txs = await money.transactions(h);
      expect(byPlaid(txs, "tx-0001")).toMatchObject({ category: "Groceries", categorySource: "rule" });
      expect(byPlaid(txs, "tx-0003").category).toBe("Groceries");
      expect(byPlaid(txs, "tx-0002").category).toBe("Eating out");
      expect(byPlaid(txs, "tx-0005").categoryId).toBeNull();
    });

    it("lists rules in order and reorders them, which changes which one wins", async () => {
      const { h, groceries, fun } = await setUp();
      const first = await money.addRule(h, { field: "payee", match: "contains", pattern: "grocer", categoryId: groceries.id });
      const second = await money.addRule(h, { field: "payee", match: "contains", pattern: "sample", categoryId: fun.id });
      expect((await money.rules(h)).map((r) => r.id)).toEqual([first.id, second.id]);
      await money.importPlaid(h, sample());

      await money.reorderRules(h, [second.id, first.id]);
      expect((await money.rules(h)).map((r) => r.id)).toEqual([second.id, first.id]);
      const applied = await money.applyRules(h);
      expect(applied.categorized).toBe(1);
      expect(byPlaid(await money.transactions(h), "tx-0001").category).toBe("Fun");
    });

    it("never overrides a category set by hand or a split", async () => {
      const { h, groceries, eatingOut, fun } = await setUp();
      await money.importPlaid(h, sample());
      const txs = await money.transactions(h);
      await money.setCategory(h, byPlaid(txs, "tx-0001").id, eatingOut.id);
      await money.setSplits(h, byPlaid(txs, "tx-0003").id, [
        { categoryId: groceries.id, amountCents: -4000 },
        { categoryId: fun.id, amountCents: -106 },
      ]);
      await money.addRule(h, { field: "payee", match: "contains", pattern: "a", categoryId: groceries.id });

      await money.applyRules(h);
      await money.importPlaid(h, sample());
      const after = await money.transactions(h);
      expect(byPlaid(after, "tx-0001")).toMatchObject({ category: "Eating out", categorySource: "manual" });
      expect(byPlaid(after, "tx-0003").splits).toHaveLength(2);
      expect(byPlaid(after, "tx-0002")).toMatchObject({ category: "Groceries", categorySource: "rule" });
    });

    it("updates and removes rules; a category set by a removed rule stays until rules run again", async () => {
      const { h, groceries, eatingOut } = await setUp();
      const rule = await money.addRule(h, { field: "payee", match: "contains", pattern: "bakery", categoryId: groceries.id });
      await money.importPlaid(h, sample());
      expect((await money.updateRule(h, rule.id, { field: "payee", match: "contains", pattern: "bakery", categoryId: eatingOut.id })).category).toBe("Eating out");
      await money.applyRules(h);
      expect(byPlaid(await money.transactions(h), "tx-0002").category).toBe("Eating out");

      await money.removeRule(h, rule.id);
      expect(await money.rules(h)).toEqual([]);
      await money.applyRules(h);
      expect(byPlaid(await money.transactions(h), "tx-0002").categoryId).toBeNull();
    });

    it("refuses a blank pattern, a reorder that isn't every rule once, and another household's rule or category", async () => {
      const { h, groceries } = await setUp();
      const other = await newHousehold();
      const theirs = await money.addCategory(other, "Theirs");
      const a = await money.addRule(h, { field: "payee", match: "equals", pattern: "x", categoryId: groceries.id });
      const b = await money.addRule(h, { field: "payee", match: "equals", pattern: "y", categoryId: groceries.id });
      const theirRule = await money.addRule(other, { field: "payee", match: "equals", pattern: "z", categoryId: theirs.id });

      expect((await rejection(money.addRule(h, { field: "payee", match: "equals", pattern: "  ", categoryId: groceries.id }))).code).toBe("invalid");
      expect((await rejection(money.addRule(h, { field: "payee", match: "equals", pattern: "q", categoryId: theirs.id }))).code).toBe("not-found");
      expect((await rejection(money.reorderRules(h, [a.id]))).code).toBe("invalid");
      expect((await rejection(money.reorderRules(h, [a.id, a.id]))).code).toBe("invalid");
      expect((await rejection(money.reorderRules(h, [a.id, theirRule.id]))).code).toBe("invalid");
      expect((await rejection(money.removeRule(h, theirRule.id))).code).toBe("not-found");
      expect((await money.rules(h)).map((r) => r.id)).toEqual([a.id, b.id]);
      expect((await money.rules(other)).map((r) => r.id)).toEqual([theirRule.id]);
    });
  });
});
