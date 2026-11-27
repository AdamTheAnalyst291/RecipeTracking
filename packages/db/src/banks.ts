import mssql from "mssql";
import { MoneyError } from "./money/errors.js";
import type { MoneyAccount } from "./money.js";

/**
 * Bank connections through Plaid (card $2): one per bank login, with the sync cursor and the
 * last daily run. The access token is a Key Vault secret; only that secret's name is here.
 */

/** The result of the most recent sync of one bank. */
export interface BankRun {
  /** ISO time. */
  at: string;
  ok: boolean;
  added: number;
  updated: number;
  /** Saved transactions the bank withdrew in this run. */
  withdrawn: number;
  message: string;
  /** Plaid's error code when the run failed, such as ITEM_LOGIN_REQUIRED. */
  errorCode: string | null;
}

/** A saved transaction the bank later withdrew. It is kept, so a person can check it. */
export interface WithdrawnTransaction {
  plaidTransactionId: string;
  transactionId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  payee: string;
  account: string;
}

/** A connected bank as the app shows it. Never holds the access token or its secret's name. */
export interface Bank {
  id: string;
  institution: string | null;
  accounts: MoneyAccount[];
  /** The bank needs its login repaired through Plaid Link's update mode ("Reconnect"). */
  needsReconnect: boolean;
  lastRun: BankRun | null;
  withdrawn: WithdrawnTransaction[];
}

/** What the sync needs to run one bank. */
export interface BankItem {
  id: string;
  householdId: string;
  plaidItemId: string;
  institution: string | null;
  /** The Key Vault secret holding the access token. */
  accessTokenSecret: string;
  /** Where the last successful sync ended; null before the first. */
  cursor: string | null;
}

export interface NewBank {
  plaidItemId: string;
  institution: string | null;
  accessTokenSecret: string;
  /** Plaid account ids of the accounts this login gives; they must be in money_account already. */
  plaidAccountIds: string[];
}

export type RunResult =
  | {
      ok: true;
      /** Plaid's next cursor; saved only now that the rows are. */
      cursor: string;
      added: number;
      updated: number;
      /** Plaid's `removed`: recorded when the household has that transaction. */
      removedPlaidTransactionIds: string[];
      /** Accounts this sync saw, linked to the bank. */
      plaidAccountIds?: string[];
      message: string;
    }
  | { ok: false; errorCode: string | null; needsReconnect: boolean; message: string };

export interface Banks {
  addItem(householdId: string, bank: NewBank): Promise<Bank>;
  list(householdId: string): Promise<Bank[]>;
  /** One of the household's banks, for update mode; not-found otherwise. */
  item(householdId: string, bankId: string): Promise<BankItem>;
  /** Every bank to sync, or only one household's. */
  itemsToSync(householdId?: string): Promise<BankItem[]>;
  /**
   * Records a run. A good one moves the cursor and records withdrawn transactions (returning
   * how many were new); a failed one leaves the cursor where it was.
   */
  saveRun(bankId: string, result: RunResult): Promise<number>;
}

const GUID = mssql.UniqueIdentifier;
const id = (value: unknown) => String(value).toLowerCase();
const clip = (value: string, max: number) => value.slice(0, max);

interface ItemRow {
  id: string;
  householdId: string;
  plaidItemId: string;
  institution: string | null;
  accessTokenSecret: string;
  cursor: string | null;
}
const toItem = (r: ItemRow): BankItem => ({ ...r, id: id(r.id), householdId: id(r.householdId) });
const itemSelect = `SELECT id, household_id AS householdId, plaid_item_id AS plaidItemId, institution,
  access_token_secret AS accessTokenSecret, sync_cursor AS [cursor] FROM plaid_item`;

export function createBanks(pool: mssql.ConnectionPool): Banks {
  type Runner = () => mssql.Request;

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

  async function linkAccounts(request: Runner, householdId: string, bankId: string, plaidAccountIds: string[]) {
    for (const plaidAccountId of plaidAccountIds) {
      await request()
        .input("h", GUID, householdId)
        .input("b", GUID, bankId)
        .input("p", mssql.NVarChar(100), clip(plaidAccountId.trim(), 100))
        .query(`
          INSERT plaid_item_account (plaid_item_id, household_id, account_id)
          SELECT @b, @h, a.id FROM money_account a
          WHERE a.household_id = @h AND a.plaid_account_id = @p
            AND NOT EXISTS (SELECT 1 FROM plaid_item_account x WHERE x.account_id = a.id)`);
    }
  }

  async function list(householdId: string, onlyBank?: string): Promise<Bank[]> {
    const r = pool.request().input("h", GUID, householdId);
    if (onlyBank) r.input("b", GUID, onlyBank);
    const rows = (
      await r.query(`
        SELECT id, institution, needs_reconnect AS needsReconnect, last_run_at AS at, last_run_ok AS ok,
               last_run_added AS added, last_run_updated AS updated, last_run_withdrawn AS withdrawn,
               last_run_message AS message, last_error_code AS errorCode
        FROM plaid_item WHERE household_id = @h ${onlyBank ? "AND id = @b" : ""} ORDER BY created_at, id`)
    ).recordset as {
      id: string;
      institution: string | null;
      needsReconnect: boolean;
      at: Date | null;
      ok: boolean | null;
      added: number | null;
      updated: number | null;
      withdrawn: number | null;
      message: string | null;
      errorCode: string | null;
    }[];
    const accounts = (
      await pool
        .request()
        .input("h", GUID, householdId)
        .query(`SELECT x.plaid_item_id AS bankId, a.id, a.name, a.mask FROM plaid_item_account x JOIN money_account a ON a.id = x.account_id
                WHERE x.household_id = @h ORDER BY a.name, a.id`)
    ).recordset as { bankId: string; id: string; name: string; mask: string | null }[];
    const withdrawn = (
      await pool.request().input("h", GUID, householdId).query(`
        SELECT w.plaid_item_id AS bankId, w.plaid_transaction_id AS plaidTransactionId, t.id AS transactionId,
               CONVERT(CHAR(10), t.posted_on, 23) AS date, t.amount_cents AS amountCents, t.payee, a.name AS account
        FROM plaid_withdrawn w
        JOIN money_transaction t ON t.household_id = w.household_id AND t.plaid_transaction_id = w.plaid_transaction_id
        JOIN money_account a ON a.id = t.account_id
        WHERE w.household_id = @h ORDER BY t.posted_on DESC, t.id`)
    ).recordset as (Omit<WithdrawnTransaction, "amountCents"> & { bankId: string; amountCents: string })[];

    return rows.map((row) => ({
      id: id(row.id),
      institution: row.institution,
      accounts: accounts.filter((a) => id(a.bankId) === id(row.id)).map((a) => ({ id: id(a.id), name: a.name, mask: a.mask })),
      needsReconnect: row.needsReconnect,
      lastRun:
        row.at === null
          ? null
          : {
              at: row.at.toISOString(),
              ok: row.ok === true,
              added: row.added ?? 0,
              updated: row.updated ?? 0,
              withdrawn: row.withdrawn ?? 0,
              message: row.message ?? "",
              errorCode: row.errorCode,
            },
      withdrawn: withdrawn
        .filter((w) => id(w.bankId) === id(row.id))
        .map(({ plaidTransactionId, transactionId, date, amountCents, payee, account }) => ({
          plaidTransactionId,
          transactionId: id(transactionId),
          date,
          amountCents: Number(amountCents),
          payee,
          account,
        })),
    }));
  }

  return {
    async addItem(householdId, bank) {
      const plaidItemId = clip(String(bank.plaidItemId ?? "").trim(), 100);
      if (!plaidItemId) throw new MoneyError("invalid", "A Plaid item has no item_id.");
      const institution = bank.institution?.trim() ? clip(bank.institution.trim(), 200) : null;
      const bankId = await inTransaction(async (request) => {
        const r = await request()
          .input("h", GUID, householdId)
          .input("p", mssql.NVarChar(100), plaidItemId)
          .input("i", mssql.NVarChar(200), institution)
          .input("s", mssql.NVarChar(127), clip(bank.accessTokenSecret, 127))
          .query(`
            DECLARE @id UNIQUEIDENTIFIER;
            SELECT @id = id FROM plaid_item WITH (UPDLOCK, HOLDLOCK) WHERE household_id = @h AND plaid_item_id = @p;
            IF @id IS NULL
            BEGIN
              DECLARE @new TABLE (id UNIQUEIDENTIFIER);
              INSERT plaid_item (household_id, plaid_item_id, institution, access_token_secret) OUTPUT inserted.id INTO @new VALUES (@h, @p, @i, @s);
              SELECT id FROM @new;
            END
            ELSE
            BEGIN
              UPDATE plaid_item SET institution = ISNULL(@i, institution), access_token_secret = @s WHERE id = @id;
              SELECT @id AS id;
            END`);
        const newId = id(r.recordset[0].id);
        await linkAccounts(request, householdId, newId, bank.plaidAccountIds);
        return newId;
      });
      const [added] = await list(householdId, bankId);
      if (!added) throw new MoneyError("not-found", "There's no such bank.");
      return added;
    },

    list: (householdId) => list(householdId),

    async item(householdId, bankId) {
      const r = await pool.request().input("h", GUID, householdId).input("b", GUID, bankId).query(`${itemSelect} WHERE household_id = @h AND id = @b`);
      const row = r.recordset[0] as ItemRow | undefined;
      if (!row) throw new MoneyError("not-found", "There's no such bank.");
      return toItem(row);
    },

    async itemsToSync(householdId) {
      const r = pool.request();
      if (householdId) r.input("h", GUID, householdId);
      const rows = (await r.query(`${itemSelect} ${householdId ? "WHERE household_id = @h" : ""} ORDER BY household_id, created_at, id`)).recordset as ItemRow[];
      return rows.map(toItem);
    },

    async saveRun(bankId, result) {
      return inTransaction(async (request) => {
        const found = await request().input("b", GUID, bankId).query("SELECT household_id AS h FROM plaid_item WITH (UPDLOCK) WHERE id = @b");
        if (found.recordset.length === 0) throw new MoneyError("not-found", "There's no such bank.");
        const householdId = id(found.recordset[0].h);
        const message = clip(result.message, 1000);

        if (!result.ok) {
          await request()
            .input("b", GUID, bankId)
            .input("m", mssql.NVarChar(1000), message)
            .input("c", mssql.NVarChar(100), result.errorCode === null ? null : clip(result.errorCode, 100))
            .input("r", mssql.Bit, result.needsReconnect)
            .query(`
              UPDATE plaid_item SET last_run_at = SYSUTCDATETIME(), last_run_ok = 0, last_run_added = 0, last_run_updated = 0,
                last_run_withdrawn = 0, last_run_message = @m, last_error_code = @c, needs_reconnect = CASE WHEN @r = 1 THEN 1 ELSE needs_reconnect END
              WHERE id = @b`);
          return 0;
        }

        // Never cut a cursor short: a wrong one would make Plaid send the wrong changes.
        if (result.cursor.length > 1000) throw new MoneyError("invalid", "Plaid's cursor is longer than the 1000 characters kept.");
        await linkAccounts(request, householdId, bankId, result.plaidAccountIds ?? []);
        let withdrawn = 0;
        for (const plaidTransactionId of new Set(result.removedPlaidTransactionIds)) {
          const r = await request()
            .input("h", GUID, householdId)
            .input("b", GUID, bankId)
            .input("p", mssql.NVarChar(100), clip(plaidTransactionId, 100))
            .query(`
              INSERT plaid_withdrawn (household_id, plaid_transaction_id, plaid_item_id)
              SELECT @h, @p, @b
              WHERE EXISTS (SELECT 1 FROM money_transaction WHERE household_id = @h AND plaid_transaction_id = @p)
                AND NOT EXISTS (SELECT 1 FROM plaid_withdrawn WHERE household_id = @h AND plaid_transaction_id = @p)`);
          withdrawn += r.rowsAffected[0] ?? 0;
        }
        await request()
          .input("b", GUID, bankId)
          .input("cur", mssql.NVarChar(1000), result.cursor)
          .input("a", mssql.Int, result.added)
          .input("u", mssql.Int, result.updated)
          .input("w", mssql.Int, withdrawn)
          .input("m", mssql.NVarChar(1000), message)
          .query(`
            UPDATE plaid_item SET sync_cursor = @cur, last_run_at = SYSUTCDATETIME(), last_run_ok = 1, last_run_added = @a,
              last_run_updated = @u, last_run_withdrawn = @w, last_run_message = @m, last_error_code = NULL, needs_reconnect = 0
            WHERE id = @b`);
        return withdrawn;
      });
    },
  };
}
