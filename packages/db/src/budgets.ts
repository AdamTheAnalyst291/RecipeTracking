import mssql from "mssql";
import { MoneyError } from "./money/errors.js";

// Monthly category budgets and spend vs budget (card $3, ADR-27). Amounts are whole cents.

/** One category's month: what was spent and its budget, if it has one. */
export interface BudgetLine {
  categoryId: string;
  category: string;
  /**
   * Money out in this category during the month, less refunds: the negated sum of its
   * transactions and split parts posted that month. Negative when refunds outweigh spending.
   */
  spentCents: number;
  /** The month's budget, or null when the category has none. */
  budgetCents: number | null;
  /** The month (`YYYY-MM`) this budget was set from; it carries forward until changed. */
  budgetFrom: string | null;
}

export interface MonthBudget {
  /** `YYYY-MM`. */
  month: string;
  /**
   * Spending categories only: Groceries first (always, when the household has that
   * category), then by name every category with a budget this month or with money spent in
   * it. A category with no budget whose month is money in isn't listed. Not-spending
   * categories (transfers, pay, other income) are never listed, budget or not.
   */
  lines: BudgetLine[];
}

export interface Budgets {
  /** Spend vs budget per category for one month (`YYYY-MM`), counted on posted dates. */
  month(householdId: string, month: string): Promise<MonthBudget>;
  /**
   * Sets a category's monthly budget from `month` onwards, until a later month's budget; null
   * clears it from that month. Only a spending category takes an amount. Returns that
   * month's spend vs budget.
   */
  setBudget(householdId: string, categoryId: string, month: string, amountCents: number | null): Promise<MonthBudget>;
}

const GUID = mssql.UniqueIdentifier;
const id = (value: unknown) => String(value).toLowerCase();
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** A monthly budget of up to ten million dollars. */
const MAX_BUDGET_CENTS = 1_000_000_000;

/** `YYYY-MM` as the first day of that month, `YYYY-MM-01`. */
function firstDay(month: unknown): string {
  if (typeof month !== "string" || !MONTH.test(month) || month < "1900-01") throw new MoneyError("invalid", "A month is written YYYY-MM.");
  return `${month}-01`;
}

function checkAmount(amountCents: number | null): number | null {
  if (amountCents === null) return null;
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > MAX_BUDGET_CENTS) {
    throw new MoneyError("invalid", "A budget is a whole number of cents, from 0 to $10,000,000.");
  }
  return amountCents;
}

interface LineRow {
  categoryId: string;
  category: string;
  spentCents: string | number;
  budgetCents: string | number | null;
  budgetFrom: string | null;
}

// Spending counts only categorized money: a transaction's own category, or each part of a
// split in its own category (a split transaction has no category of its own). Uncategorized
// money counts nowhere, and not-spending categories (transfers, pay, other income; card $6)
// are left out entirely, so their money is never spending or a refund.
const monthQuery = `
  DECLARE @end DATE = DATEADD(MONTH, 1, @m);
  WITH parts AS (
    SELECT t.category_id, t.amount_cents
    FROM money_transaction t
    WHERE t.household_id = @h AND t.category_id IS NOT NULL AND t.posted_on >= @m AND t.posted_on < @end
      AND NOT EXISTS (SELECT 1 FROM money_split s WHERE s.transaction_id = t.id)
    UNION ALL
    SELECT s.category_id, s.amount_cents
    FROM money_split s JOIN money_transaction t ON t.id = s.transaction_id AND t.household_id = s.household_id
    WHERE s.household_id = @h AND t.posted_on >= @m AND t.posted_on < @end
  ),
  spent AS (SELECT category_id, -SUM(amount_cents) AS cents FROM parts GROUP BY category_id),
  latest AS (
    SELECT b.category_id, b.amount_cents, b.starts_on,
           ROW_NUMBER() OVER (PARTITION BY b.category_id ORDER BY b.starts_on DESC) AS newest
    FROM money_budget b WHERE b.household_id = @h AND b.starts_on <= @m
  )
  SELECT c.id AS categoryId, c.name AS category, COALESCE(s.cents, 0) AS spentCents,
         b.amount_cents AS budgetCents, CASE WHEN b.amount_cents IS NULL THEN NULL ELSE CONVERT(CHAR(7), b.starts_on, 23) END AS budgetFrom
  FROM money_category c
  LEFT JOIN spent s ON s.category_id = c.id
  LEFT JOIN latest b ON b.category_id = c.id AND b.newest = 1
  WHERE c.household_id = @h AND c.kind = 'spending' AND (c.name = N'Groceries' OR b.amount_cents IS NOT NULL OR s.cents > 0)
  ORDER BY CASE WHEN c.name = N'Groceries' THEN 0 ELSE 1 END, c.name, c.id`;

export function createBudgets(pool: mssql.ConnectionPool): Budgets {
  async function month(householdId: string, monthText: string): Promise<MonthBudget> {
    const start = firstDay(monthText);
    const r = await pool.request().input("h", GUID, householdId).input("m", mssql.Date, start).query(monthQuery);
    return {
      month: monthText,
      lines: (r.recordset as LineRow[]).map((row) => ({
        categoryId: id(row.categoryId),
        category: row.category,
        spentCents: Number(row.spentCents),
        budgetCents: row.budgetCents === null ? null : Number(row.budgetCents),
        budgetFrom: row.budgetFrom,
      })),
    };
  }

  return {
    month,

    async setBudget(householdId, categoryId, monthText, amountCents) {
      const start = firstDay(monthText);
      const amount = checkAmount(amountCents);
      const r = await pool
        .request()
        .input("h", GUID, householdId)
        .input("c", GUID, categoryId)
        .input("m", mssql.Date, start)
        .input("a", mssql.BigInt, amount)
        .query(`
          DECLARE @kind VARCHAR(20) = (SELECT kind FROM money_category WHERE id = @c AND household_id = @h);
          IF @kind IS NULL
            SELECT CAST(0 AS BIT) AS found, CAST(NULL AS VARCHAR(20)) AS kind;
          ELSE IF @kind <> 'spending' AND @a IS NOT NULL
            SELECT CAST(1 AS BIT) AS found, @kind AS kind;
          ELSE
          BEGIN
            MERGE money_budget WITH (HOLDLOCK) AS b
            USING (SELECT @h AS household_id, @c AS category_id, @m AS starts_on) AS s
              ON b.household_id = s.household_id AND b.category_id = s.category_id AND b.starts_on = s.starts_on
            WHEN MATCHED THEN UPDATE SET amount_cents = @a, updated_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (household_id, category_id, starts_on, amount_cents) VALUES (@h, @c, @m, @a);
            SELECT CAST(1 AS BIT) AS found, @kind AS kind;
          END`);
      const result = r.recordset[0] as { found: boolean; kind: string | null };
      if (!result.found) throw new MoneyError("not-found", "There's no such category.");
      if (result.kind !== "spending" && amount !== null) throw new MoneyError("invalid", "Only a spending category can have a budget.");
      return month(householdId, monthText);
    },
  };
}
