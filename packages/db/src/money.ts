import mssql from "mssql";
import { MoneyError } from "./money/errors.js";
import { fromPlaid, type ImportRow, type PlaidAccount, type PlaidTransaction } from "./money/plaid.js";
import { pickCategory, type RuleField, type RuleLike, type RuleMatch } from "./money/rules.js";
import { checkSplits, type SplitInput } from "./money/splits.js";

export { MoneyError } from "./money/errors.js";
export { toCents, type PlaidAccount, type PlaidTransaction } from "./money/plaid.js";
export { pickCategory, type RuleField, type RuleMatch } from "./money/rules.js";
export { checkSplits, MAX_SPLITS, type SplitInput } from "./money/splits.js";

// Amounts are whole cents; money out of an account is negative, money in positive.

export interface MoneyAccount {
  id: string;
  name: string;
  /** The last digits the bank shows, never the full number. */
  mask: string | null;
}

export interface Category {
  id: string;
  name: string;
}

export interface Split {
  categoryId: string;
  category: string;
  amountCents: number;
}

export interface Transaction {
  id: string;
  accountId: string;
  account: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  payee: string;
  description: string;
  plaidTransactionId: string | null;
  /** Null when uncategorized or split. */
  categoryId: string | null;
  category: string | null;
  /** Who set the category: a rule, or a person (`manual`), which rules never override. */
  categorySource: "rule" | "manual" | null;
  /** Empty unless the transaction is split; then the amounts add up to `amountCents`. */
  splits: Split[];
}

export interface Rule {
  id: string;
  /** Rules run in this order; the first that matches wins. */
  position: number;
  field: RuleField;
  match: RuleMatch;
  pattern: string;
  categoryId: string;
  category: string;
}

export interface NewRule {
  field: RuleField;
  match: RuleMatch;
  pattern: string;
  categoryId: string;
}

/** What Plaid's sync hands over: the accounts and their transactions, in Plaid's own shape. */
export interface PlaidImport {
  accounts: PlaidAccount[];
  transactions: PlaidTransaction[];
}

export interface ImportReport {
  added: number;
  updated: number;
  /** Pending transactions change id when they post, so only posted ones are kept. */
  skippedPending: number;
  skippedUnknownAccount: number;
  /** Split transactions whose amount changed: their splits no longer added up, so they were cleared. */
  splitsCleared: number;
  categorizedByRule: number;
}

export interface TransactionFilter {
  /** Only transactions with neither a category nor splits. */
  uncategorized?: boolean;
  /** At most this many, newest first. Defaults to 200, at most 500. */
  limit?: number;
}

export interface Money {
  accounts(householdId: string): Promise<MoneyAccount[]>;
  categories(householdId: string): Promise<Category[]>;
  addCategory(householdId: string, name: string): Promise<Category>;
  renameCategory(householdId: string, categoryId: string, name: string): Promise<Category>;

  /** Newest first. */
  transactions(householdId: string, filter?: TransactionFilter): Promise<Transaction[]>;
  /** Sets one category by hand (or clears it with null). Any splits are replaced. */
  setCategory(householdId: string, transactionId: string, categoryId: string | null): Promise<Transaction>;
  /** Replaces the splits; they must add up to the transaction. An empty list un-splits it. */
  setSplits(householdId: string, transactionId: string, splits: SplitInput[]): Promise<Transaction>;

  /** In the order they run. */
  rules(householdId: string): Promise<Rule[]>;
  /** Adds a rule at the end, so it runs last. */
  addRule(householdId: string, rule: NewRule): Promise<Rule>;
  updateRule(householdId: string, ruleId: string, rule: NewRule): Promise<Rule>;
  removeRule(householdId: string, ruleId: string): Promise<void>;
  /** Puts the rules in this order; it must name every rule of the household once. */
  reorderRules(householdId: string, ruleIds: string[]): Promise<Rule[]>;
  /** Runs the rules over every transaction not categorized by hand and not split. */
  applyRules(householdId: string): Promise<{ categorized: number }>;

  /**
   * Adds or updates accounts and posted transactions from Plaid, matched by Plaid's ids, so a
   * repeated id updates instead of duplicating. Rules then categorize what wasn't set by hand.
   */
  importPlaid(householdId: string, data: PlaidImport): Promise<ImportReport>;
}

const GUID = mssql.UniqueIdentifier;
const id = (value: unknown) => String(value).toLowerCase();
const MAX_NAME = 100;
const MAX_PATTERN = 200;
const MAX_TRANSACTIONS = 500;
const MAX_IMPORT = 5000;

function cleanName(name: unknown, what: string, max: number): string {
  const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!value) throw new MoneyError("invalid", `${what} can't be empty.`);
  if (value.length > max) throw new MoneyError("invalid", `${what} can be at most ${max} characters.`);
  return value;
}

function checkRule(rule: NewRule): NewRule {
  if (rule.field !== "payee" && rule.field !== "description") throw new MoneyError("invalid", "A rule looks at the payee or the description.");
  if (rule.match !== "equals" && rule.match !== "contains") throw new MoneyError("invalid", "A rule matches with equals or contains.");
  return { ...rule, pattern: cleanName(rule.pattern, "A rule's text", MAX_PATTERN) };
}

const isDuplicateKey = (e: unknown) => e instanceof Error && "number" in e && (e.number === 2627 || e.number === 2601);

/** Runs a category write, turning a clash with an existing name into a conflict. */
async function uniqueName<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isDuplicateKey(e)) throw new MoneyError("conflict", `There's already a category called ${name}.`);
    throw e;
  }
}

interface TransactionRow {
  id: string;
  accountId: string;
  account: string;
  date: string;
  amountCents: string | number;
  payee: string;
  description: string;
  plaidTransactionId: string | null;
  categoryId: string | null;
  category: string | null;
  categorySource: "rule" | "manual" | null;
}

const transactionSelect = `
  SELECT t.id, t.account_id AS accountId, a.name AS account, CONVERT(CHAR(10), t.posted_on, 23) AS date,
         t.amount_cents AS amountCents, t.payee, t.description, t.plaid_transaction_id AS plaidTransactionId,
         t.category_id AS categoryId, c.name AS category, t.category_source AS categorySource
  FROM money_transaction t
  JOIN money_account a ON a.id = t.account_id
  LEFT JOIN money_category c ON c.id = t.category_id`;

const ruleSelect = `
  SELECT r.id, r.position, r.field, r.match_type AS [match], r.pattern, r.category_id AS categoryId, c.name AS category
  FROM money_rule r JOIN money_category c ON c.id = r.category_id`;

const toRule = (row: Rule): Rule => ({ ...row, id: id(row.id), categoryId: id(row.categoryId) });

type Runner = () => mssql.Request;

export function createMoney(pool: mssql.ConnectionPool): Money {
  const onPool: Runner = () => pool.request();

  async function inTransaction<T>(work: (request: Runner) => Promise<T>): Promise<T> {
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      const result = await work(() => new mssql.Request(tx));
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  async function loadTransactions(request: Runner, householdId: string, where: string, top: number, inputs: (r: mssql.Request) => mssql.Request = (r) => r) {
    const rows = (
      await inputs(request().input("h", GUID, householdId).input("top", mssql.Int, top)).query(
        `${transactionSelect} WHERE t.household_id = @h ${where}
         ORDER BY t.posted_on DESC, t.created_at DESC, t.id DESC OFFSET 0 ROWS FETCH NEXT @top ROWS ONLY`,
      )
    ).recordset as TransactionRow[];
    const splits = new Map<string, Split[]>();
    if (rows.length > 0) {
      const r = request().input("h", GUID, householdId);
      rows.forEach((row, i) => r.input(`t${i}`, GUID, row.id));
      const found = await r.query(
        `SELECT s.transaction_id AS transactionId, s.category_id AS categoryId, c.name AS category, s.amount_cents AS amountCents
         FROM money_split s JOIN money_category c ON c.id = s.category_id
         WHERE s.household_id = @h AND s.transaction_id IN (${rows.map((_, i) => `@t${i}`).join(", ")})
         ORDER BY s.position`,
      );
      for (const s of found.recordset as { transactionId: string; categoryId: string; category: string; amountCents: string }[]) {
        const list = splits.get(id(s.transactionId)) ?? [];
        list.push({ categoryId: id(s.categoryId), category: s.category, amountCents: Number(s.amountCents) });
        splits.set(id(s.transactionId), list);
      }
    }
    return rows.map(
      (row): Transaction => ({
        id: id(row.id),
        accountId: id(row.accountId),
        account: row.account,
        date: row.date,
        amountCents: Number(row.amountCents),
        payee: row.payee,
        description: row.description,
        plaidTransactionId: row.plaidTransactionId,
        categoryId: row.categoryId === null ? null : id(row.categoryId),
        category: row.category,
        categorySource: row.categorySource,
        splits: splits.get(id(row.id)) ?? [],
      }),
    );
  }

  async function oneTransaction(request: Runner, householdId: string, transactionId: string): Promise<Transaction> {
    const [tx] = await loadTransactions(request, householdId, "AND t.id = @t", 1, (r) => r.input("t", GUID, transactionId));
    if (!tx) throw new MoneyError("not-found", "There's no such transaction.");
    return tx;
  }

  async function checkCategory(request: Runner, householdId: string, categoryId: string): Promise<void> {
    const r = await request().input("h", GUID, householdId).input("c", GUID, categoryId).query("SELECT 1 AS ok FROM money_category WHERE id = @c AND household_id = @h");
    if (r.recordset.length === 0) throw new MoneyError("not-found", "There's no such category.");
  }

  /** Locks the transaction row for the rest of the database transaction; not-found when it isn't the household's. */
  async function lockTransaction(request: Runner, householdId: string, transactionId: string): Promise<{ amountCents: number }> {
    const r = await request()
      .input("h", GUID, householdId)
      .input("t", GUID, transactionId)
      .query("SELECT amount_cents AS amountCents FROM money_transaction WITH (UPDLOCK, ROWLOCK) WHERE id = @t AND household_id = @h");
    const row = r.recordset[0] as { amountCents: string } | undefined;
    if (!row) throw new MoneyError("not-found", "There's no such transaction.");
    return { amountCents: Number(row.amountCents) };
  }

  async function loadRules(request: Runner, householdId: string): Promise<Rule[]> {
    const r = await request().input("h", GUID, householdId).query(`${ruleSelect} WHERE r.household_id = @h ORDER BY r.position`);
    return (r.recordset as Rule[]).map(toRule);
  }

  async function lockRules(request: Runner, householdId: string): Promise<void> {
    await request()
      .input("res", mssql.NVarChar(100), `kitchen-money-rules-${id(householdId)}`)
      .query(`
        DECLARE @r INT;
        EXEC @r = sp_getapplock @Resource = @res, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000;
        IF @r < 0 THROW 50000, 'Could not get the money lock', 1;`);
  }

  /**
   * Sets the rule's category on transactions that rules may touch (not set by hand, not split),
   * or clears one a rule had set when no rule matches any more. Returns how many changed.
   */
  async function runRules(request: Runner, householdId: string, rules: RuleLike[], onlyIds?: string[]): Promise<number> {
    if (onlyIds && onlyIds.length === 0) return 0;
    const r = request().input("h", GUID, householdId);
    let only = "";
    if (onlyIds) {
      onlyIds.forEach((t, i) => r.input(`t${i}`, GUID, t));
      only = `AND t.id IN (${onlyIds.map((_, i) => `@t${i}`).join(", ")})`;
    }
    const candidates = (
      await r.query(
        `SELECT t.id, t.payee, t.description, t.category_id AS categoryId FROM money_transaction t
         WHERE t.household_id = @h AND (t.category_source IS NULL OR t.category_source = 'rule')
           AND NOT EXISTS (SELECT 1 FROM money_split s WHERE s.transaction_id = t.id) ${only}`,
      )
    ).recordset as { id: string; payee: string; description: string; categoryId: string | null }[];
    let changed = 0;
    for (const tx of candidates) {
      const want = pickCategory(rules, tx) ?? null;
      const have = tx.categoryId === null ? null : id(tx.categoryId);
      if (want === have) continue;
      await request()
        .input("h", GUID, householdId)
        .input("t", GUID, tx.id)
        .input("c", GUID, want)
        .query(
          `UPDATE money_transaction SET category_id = @c, category_source = CASE WHEN @c IS NULL THEN NULL ELSE 'rule' END, updated_at = SYSUTCDATETIME()
           WHERE id = @t AND household_id = @h
             -- Checked again here, so a category set by hand or a split made meanwhile is never overwritten.
             AND (category_source IS NULL OR category_source = 'rule')
             AND NOT EXISTS (SELECT 1 FROM money_split s WHERE s.transaction_id = @t)`,
        );
      if (want !== null) changed++;
    }
    return changed;
  }

  async function oneRule(request: Runner, householdId: string, ruleId: string): Promise<Rule> {
    const r = await request().input("h", GUID, householdId).input("r", GUID, ruleId).query(`${ruleSelect} WHERE r.household_id = @h AND r.id = @r`);
    const row = r.recordset[0] as Rule | undefined;
    if (!row) throw new MoneyError("not-found", "There's no such rule.");
    return toRule(row);
  }

  async function upsertAccount(request: Runner, householdId: string, account: PlaidAccount): Promise<void> {
    const plaidId = String(account.account_id ?? "").trim().slice(0, 100);
    if (!plaidId) throw new MoneyError("invalid", "A Plaid account has no account_id.");
    const name = (String(account.name ?? "").trim() || "Account").slice(0, 200);
    const mask = account.mask ? String(account.mask).trim().slice(-4) : null;
    await request()
      .input("h", GUID, householdId)
      .input("p", mssql.NVarChar(100), plaidId)
      .input("n", mssql.NVarChar(200), name)
      .input("m", mssql.NVarChar(10), mask)
      .query(`
        UPDATE money_account SET name = @n, mask = @m WHERE household_id = @h AND plaid_account_id = @p;
        IF @@ROWCOUNT = 0 INSERT money_account (household_id, name, mask, plaid_account_id) VALUES (@h, @n, @m, @p);`);
  }

  return {
    async accounts(householdId) {
      const r = await onPool().input("h", GUID, householdId).query("SELECT id, name, mask FROM money_account WHERE household_id = @h ORDER BY name, id");
      return (r.recordset as MoneyAccount[]).map((a) => ({ id: id(a.id), name: a.name, mask: a.mask }));
    },

    async categories(householdId) {
      const r = await onPool().input("h", GUID, householdId).query("SELECT id, name FROM money_category WHERE household_id = @h ORDER BY name, id");
      return (r.recordset as Category[]).map((c) => ({ id: id(c.id), name: c.name }));
    },

    async addCategory(householdId, name) {
      const clean = cleanName(name, "A category name", MAX_NAME);
      return uniqueName(clean, async () => {
        const r = await onPool()
          .input("h", GUID, householdId)
          .input("n", mssql.NVarChar(MAX_NAME), clean)
          .query("INSERT money_category (household_id, name) OUTPUT inserted.id, inserted.name VALUES (@h, @n)");
        const row = r.recordset[0] as Category;
        return { id: id(row.id), name: row.name };
      });
    },

    async renameCategory(householdId, categoryId, name) {
      const clean = cleanName(name, "A category name", MAX_NAME);
      return uniqueName(clean, async () => {
        const r = await onPool()
          .input("h", GUID, householdId)
          .input("c", GUID, categoryId)
          .input("n", mssql.NVarChar(MAX_NAME), clean)
          .query("UPDATE money_category SET name = @n OUTPUT inserted.id, inserted.name WHERE id = @c AND household_id = @h");
        const row = r.recordset[0] as Category | undefined;
        if (!row) throw new MoneyError("not-found", "There's no such category.");
        return { id: id(row.id), name: row.name };
      });
    },

    async transactions(householdId, filter = {}) {
      const limit = filter.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTIONS) {
        throw new MoneyError("invalid", `The limit must be a whole number from 1 to ${MAX_TRANSACTIONS}.`);
      }
      const where = filter.uncategorized
        ? "AND t.category_id IS NULL AND NOT EXISTS (SELECT 1 FROM money_split s WHERE s.transaction_id = t.id)"
        : "";
      return loadTransactions(onPool, householdId, where, limit);
    },

    async setCategory(householdId, transactionId, categoryId) {
      return inTransaction(async (request) => {
        await lockTransaction(request, householdId, transactionId);
        if (categoryId !== null) await checkCategory(request, householdId, categoryId);
        await request().input("h", GUID, householdId).input("t", GUID, transactionId).query("DELETE money_split WHERE transaction_id = @t AND household_id = @h");
        await request()
          .input("h", GUID, householdId)
          .input("t", GUID, transactionId)
          .input("c", GUID, categoryId)
          .query(
            `UPDATE money_transaction SET category_id = @c, category_source = CASE WHEN @c IS NULL THEN NULL ELSE 'manual' END, updated_at = SYSUTCDATETIME()
             WHERE id = @t AND household_id = @h`,
          );
        return oneTransaction(request, householdId, transactionId);
      });
    },

    async setSplits(householdId, transactionId, splits) {
      return inTransaction(async (request) => {
        const { amountCents } = await lockTransaction(request, householdId, transactionId);
        checkSplits(amountCents, splits);
        for (const split of splits) await checkCategory(request, householdId, split.categoryId);
        await request().input("h", GUID, householdId).input("t", GUID, transactionId).query("DELETE money_split WHERE transaction_id = @t AND household_id = @h");
        for (const [i, split] of splits.entries()) {
          await request()
            .input("h", GUID, householdId)
            .input("t", GUID, transactionId)
            .input("c", GUID, split.categoryId)
            .input("p", mssql.Int, i + 1)
            .input("a", mssql.BigInt, split.amountCents)
            .query("INSERT money_split (transaction_id, household_id, category_id, position, amount_cents) VALUES (@t, @h, @c, @p, @a)");
        }
        // A split transaction has no single category. Un-splitting leaves it uncategorized.
        await request()
          .input("h", GUID, householdId)
          .input("t", GUID, transactionId)
          .query("UPDATE money_transaction SET category_id = NULL, category_source = NULL, updated_at = SYSUTCDATETIME() WHERE id = @t AND household_id = @h");
        return oneTransaction(request, householdId, transactionId);
      });
    },

    async rules(householdId) {
      return loadRules(onPool, householdId);
    },

    async addRule(householdId, rule) {
      const clean = checkRule(rule);
      return inTransaction(async (request) => {
        await lockRules(request, householdId);
        await checkCategory(request, householdId, clean.categoryId);
        const r = await request()
          .input("h", GUID, householdId)
          .input("f", mssql.VarChar(11), clean.field)
          .input("m", mssql.VarChar(8), clean.match)
          .input("p", mssql.NVarChar(MAX_PATTERN), clean.pattern)
          .input("c", GUID, clean.categoryId)
          .query(
            `INSERT money_rule (household_id, position, field, match_type, pattern, category_id) OUTPUT inserted.id
             VALUES (@h, (SELECT ISNULL(MAX(position), 0) + 1 FROM money_rule WHERE household_id = @h), @f, @m, @p, @c)`,
          );
        return oneRule(request, householdId, r.recordset[0].id as string);
      });
    },

    async updateRule(householdId, ruleId, rule) {
      const clean = checkRule(rule);
      return inTransaction(async (request) => {
        await lockRules(request, householdId);
        await checkCategory(request, householdId, clean.categoryId);
        const r = await request()
          .input("h", GUID, householdId)
          .input("r", GUID, ruleId)
          .input("f", mssql.VarChar(11), clean.field)
          .input("m", mssql.VarChar(8), clean.match)
          .input("p", mssql.NVarChar(MAX_PATTERN), clean.pattern)
          .input("c", GUID, clean.categoryId)
          .query("UPDATE money_rule SET field = @f, match_type = @m, pattern = @p, category_id = @c WHERE id = @r AND household_id = @h");
        if (r.rowsAffected[0] === 0) throw new MoneyError("not-found", "There's no such rule.");
        return oneRule(request, householdId, ruleId);
      });
    },

    async removeRule(householdId, ruleId) {
      await inTransaction(async (request) => {
        await lockRules(request, householdId);
        const r = await request().input("h", GUID, householdId).input("r", GUID, ruleId).query("DELETE money_rule WHERE id = @r AND household_id = @h");
        if (r.rowsAffected[0] === 0) throw new MoneyError("not-found", "There's no such rule.");
      });
    },

    async reorderRules(householdId, ruleIds) {
      return inTransaction(async (request) => {
        await lockRules(request, householdId);
        const current = await loadRules(request, householdId);
        const wanted = ruleIds.map((r) => r.toLowerCase());
        const known = new Set(current.map((r) => r.id));
        if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((r) => known.has(r))) {
          throw new MoneyError("invalid", "The new order must name every rule exactly once.");
        }
        // Positions are unique, so move every rule out of the way first.
        await request().input("h", GUID, householdId).query("UPDATE money_rule SET position = -position WHERE household_id = @h");
        for (const [i, ruleId] of wanted.entries()) {
          await request().input("h", GUID, householdId).input("r", GUID, ruleId).input("p", mssql.Int, i + 1).query("UPDATE money_rule SET position = @p WHERE id = @r AND household_id = @h");
        }
        return loadRules(request, householdId);
      });
    },

    async applyRules(householdId) {
      return inTransaction(async (request) => {
        await lockRules(request, householdId);
        return { categorized: await runRules(request, householdId, await loadRules(request, householdId)) };
      });
    },

    async importPlaid(householdId, data) {
      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
      if (transactions.length > MAX_IMPORT) throw new MoneyError("invalid", `An import can hold at most ${MAX_IMPORT} transactions.`);
      // Check everything before writing anything.
      const rows: ImportRow[] = [];
      let skippedPending = 0;
      for (const tx of transactions) {
        if (tx.pending) skippedPending++;
        else rows.push(fromPlaid(tx));
      }

      return inTransaction(async (request) => {
        await lockRules(request, householdId);
        for (const account of accounts) await upsertAccount(request, householdId, account);
        const accountIds = new Map<string, string>();
        for (const a of (await request().input("h", GUID, householdId).query("SELECT id, plaid_account_id AS plaidId FROM money_account WHERE household_id = @h AND plaid_account_id IS NOT NULL")).recordset) {
          accountIds.set(String(a.plaidId), id(a.id));
        }

        const report: ImportReport = { added: 0, updated: 0, skippedPending, skippedUnknownAccount: 0, splitsCleared: 0, categorizedByRule: 0 };
        const touched = new Set<string>();
        for (const row of rows) {
          const accountId = accountIds.get(row.plaidAccountId);
          if (!accountId) {
            report.skippedUnknownAccount++;
            continue;
          }
          const r = await request()
            .input("h", GUID, householdId)
            .input("a", GUID, accountId)
            .input("p", mssql.NVarChar(100), row.plaidTransactionId)
            .input("d", mssql.Date, row.date)
            .input("amt", mssql.BigInt, row.amountCents)
            .input("payee", mssql.NVarChar(200), row.payee)
            .input("desc", mssql.NVarChar(500), row.description)
            .query(`
              DECLARE @id UNIQUEIDENTIFIER, @old BIGINT, @cleared INT = 0;
              SELECT @id = id, @old = amount_cents FROM money_transaction WITH (UPDLOCK) WHERE household_id = @h AND plaid_transaction_id = @p;
              IF @id IS NULL
              BEGIN
                DECLARE @new TABLE (id UNIQUEIDENTIFIER);
                INSERT money_transaction (household_id, account_id, posted_on, amount_cents, payee, description, plaid_transaction_id)
                OUTPUT inserted.id INTO @new VALUES (@h, @a, @d, @amt, @payee, @desc, @p);
                SELECT id, CAST(1 AS BIT) AS added, 0 AS cleared FROM @new;
              END
              ELSE
              BEGIN
                IF @old <> @amt
                BEGIN
                  DELETE money_split WHERE transaction_id = @id AND household_id = @h;
                  SET @cleared = @@ROWCOUNT;
                END
                UPDATE money_transaction SET account_id = @a, posted_on = @d, amount_cents = @amt, payee = @payee, description = @desc, updated_at = SYSUTCDATETIME()
                WHERE id = @id;
                SELECT @id AS id, CAST(0 AS BIT) AS added, @cleared AS cleared;
              END`);
          const result = r.recordset[0] as { id: string; added: boolean; cleared: number };
          if (result.added) report.added++;
          else report.updated++;
          if (result.cleared > 0) report.splitsCleared++;
          touched.add(id(result.id));
        }
        report.categorizedByRule = await runRules(request, householdId, await loadRules(request, householdId), [...touched]);
        return report;
      });
    },
  };
}

