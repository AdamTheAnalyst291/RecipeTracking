import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBudgets, type Budgets, type MonthBudget } from "./budgets.js";
import { runMigrations } from "./migrate.js";
import { MoneyError, createMoney, type Money } from "./money.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

// Made-up households, accounts and transactions; the repo is public.
describe.skipIf(!testServer)("budgets: monthly category budgets and spend vs budget", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let money: Money;
  let budgets: Budgets;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    money = createMoney(pool);
    budgets = createBudgets(pool);
  });
  afterAll(async () => {
    await drop();
  });

  /** A household with an account and the given categories; returns their ids by name. */
  async function household(...categories: string[]) {
    const h = (await pool.request().query("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')")).recordset[0].id as string;
    const account = (await pool.request().input("h", h).query("INSERT money_account (household_id, name) OUTPUT inserted.id VALUES (@h, 'Everyday Checking')"))
      .recordset[0].id as string;
    const cat: Record<string, string> = {};
    for (const name of categories) cat[name] = (await money.addCategory(h, name)).id;
    /** Adds a posted transaction (money out negative), optionally in a category; returns its id. */
    const tx = async (date: string, amountCents: number, category?: string) => {
      const r = await pool
        .request()
        .input("h", h)
        .input("a", account)
        .input("d", date)
        .input("c", amountCents)
        .query("INSERT money_transaction (household_id, account_id, posted_on, amount_cents, payee, description) OUTPUT inserted.id VALUES (@h, @a, @d, @c, 'Sample Payee', 'SAMPLE')");
      const id = r.recordset[0].id as string;
      if (category) await money.setCategory(h, id, cat[category]!);
      return id;
    };
    return { h, cat, tx };
  }

  const lines = (report: MonthBudget) => report.lines.map((l) => [l.category, l.spentCents, l.budgetCents]);
  async function rejection(promise: Promise<unknown>): Promise<MoneyError> {
    const e = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(e instanceof MoneyError)) throw new Error(`Expected a MoneyError, got ${String(e)}`);
    return e;
  }

  describe("spend per category and month", () => {
    it("adds up money out per category for the month, on posted dates", async () => {
      const { h, tx } = await household("Groceries", "Household");
      await tx("2026-10-31", -9999, "Groceries"); // October
      await tx("2026-11-01", -5000, "Groceries");
      await tx("2026-11-30", -2500, "Groceries");
      await tx("2026-11-15", -1234, "Household");
      await tx("2026-12-01", -7777, "Groceries"); // December

      expect(lines(await budgets.month(h, "2026-11"))).toEqual([
        ["Groceries", 7500, null],
        ["Household", 1234, null],
      ]);
      expect(lines(await budgets.month(h, "2026-10"))).toEqual([["Groceries", 9999, null]]);
      expect(lines(await budgets.month(h, "2026-12"))).toEqual([["Groceries", 7777, null]]);
    });

    it("counts each split part in its own category", async () => {
      const { h, cat, tx } = await household("Groceries", "Household");
      const id = await tx("2026-11-05", -10000);
      await money.setSplits(h, id, [
        { categoryId: cat.Groceries!, amountCents: -6000 },
        { categoryId: cat.Household!, amountCents: -4000 },
      ]);
      await tx("2026-11-06", -500, "Groceries");

      expect(lines(await budgets.month(h, "2026-11"))).toEqual([
        ["Groceries", 6500, null],
        ["Household", 4000, null],
      ]);
    });

    it("counts a refund as negative spend", async () => {
      const { h, tx } = await household("Groceries");
      await tx("2026-11-02", -8000, "Groceries");
      await tx("2026-11-09", 2000, "Groceries");

      expect(lines(await budgets.month(h, "2026-11"))).toEqual([["Groceries", 6000, null]]);
    });

    it("leaves out uncategorized money, income and transfers", async () => {
      const { h, tx } = await household("Groceries", "Pay", "Transfers");
      await tx("2026-11-01", 150000, "Pay"); // income in its own category
      await tx("2026-11-02", 150000); // income left uncategorized
      await tx("2026-11-03", -50000); // transfer to savings, uncategorized
      await tx("2026-11-04", -20000, "Transfers"); // a transfer between two of the household's accounts...
      await tx("2026-11-04", 20000, "Transfers"); // ...nets to nothing
      await tx("2026-11-05", -3000, "Groceries");

      expect(lines(await budgets.month(h, "2026-11"))).toEqual([["Groceries", 3000, null]]);
    });
  });

  describe("budgets", () => {
    it("carries a budget forward to later months until it is changed or cleared", async () => {
      const { h, cat } = await household("Groceries");
      await budgets.setBudget(h, cat.Groceries!, "2026-10", 60000);
      await budgets.setBudget(h, cat.Groceries!, "2026-12", 65000);
      await budgets.setBudget(h, cat.Groceries!, "2027-02", null);

      const budgetIn = async (month: string) => (await budgets.month(h, month)).lines.find((l) => l.category === "Groceries");
      expect(await budgetIn("2026-09")).toMatchObject({ budgetCents: null, budgetFrom: null });
      expect(await budgetIn("2026-10")).toMatchObject({ budgetCents: 60000, budgetFrom: "2026-10" });
      expect(await budgetIn("2026-11")).toMatchObject({ budgetCents: 60000, budgetFrom: "2026-10" });
      expect(await budgetIn("2026-12")).toMatchObject({ budgetCents: 65000, budgetFrom: "2026-12" });
      expect(await budgetIn("2027-01")).toMatchObject({ budgetCents: 65000, budgetFrom: "2026-12" });
      expect(await budgetIn("2027-02")).toMatchObject({ budgetCents: null, budgetFrom: null });
      expect(await budgetIn("2028-06")).toMatchObject({ budgetCents: null, budgetFrom: null });
    });

    it("setting the same month again replaces that month's amount and returns the month", async () => {
      const { h, cat } = await household("Groceries");
      await budgets.setBudget(h, cat.Groceries!, "2026-11", 50000);
      const report = await budgets.setBudget(h, cat.Groceries!, "2026-11", 55000);

      expect(report.month).toBe("2026-11");
      expect(lines(report)).toEqual([["Groceries", 0, 55000]]);
    });

    it("doesn't roll an unspent amount into the next month", async () => {
      const { h, cat, tx } = await household("Groceries");
      await budgets.setBudget(h, cat.Groceries!, "2026-10", 60000);
      await tx("2026-10-10", -40000, "Groceries");
      await tx("2026-11-10", -10000, "Groceries");

      expect(lines(await budgets.month(h, "2026-10"))).toEqual([["Groceries", 40000, 60000]]);
      expect(lines(await budgets.month(h, "2026-11"))).toEqual([["Groceries", 10000, 60000]]);
    });

    it("lists Groceries first, even with no budget or spend, then budgeted or spent categories by name", async () => {
      const { h, cat, tx } = await household("Books", "Groceries", "Household", "Unused", "Zoo");
      await budgets.setBudget(h, cat.Zoo!, "2026-11", 1000);
      await tx("2026-11-03", -700, "Books");
      await tx("2026-11-03", -300, "Household");

      expect((await budgets.month(h, "2026-11")).lines.map((l) => l.category)).toEqual(["Groceries", "Books", "Household", "Zoo"]);
    });

    it("refuses a bad month or amount, and a category that isn't the household's", async () => {
      const { h, cat } = await household("Groceries");
      const other = await household("Groceries");
      expect((await rejection(budgets.month(h, "2026-13"))).code).toBe("invalid");
      expect((await rejection(budgets.setBudget(h, cat.Groceries!, "2026-1", 100))).code).toBe("invalid");
      expect((await rejection(budgets.setBudget(h, cat.Groceries!, "2026-11", -1))).code).toBe("invalid");
      expect((await rejection(budgets.setBudget(h, cat.Groceries!, "2026-11", 1.5))).code).toBe("invalid");
      expect((await rejection(budgets.setBudget(h, other.cat.Groceries!, "2026-11", 100))).code).toBe("not-found");
    });
  });

  it("keeps each household's spend and budgets to itself", async () => {
    const mine = await household("Groceries");
    const theirs = await household("Groceries");
    await mine.tx("2026-11-02", -1000, "Groceries");
    await budgets.setBudget(mine.h, mine.cat.Groceries!, "2026-11", 40000);
    await theirs.tx("2026-11-02", -9000, "Groceries");
    await budgets.setBudget(theirs.h, theirs.cat.Groceries!, "2026-11", 90000);

    expect(lines(await budgets.month(mine.h, "2026-11"))).toEqual([["Groceries", 1000, 40000]]);
    expect(lines(await budgets.month(theirs.h, "2026-11"))).toEqual([["Groceries", 9000, 90000]]);
  });
});
