import type { BankItem, Banks, ImportReport, Money } from "@kitchen/db";
import type { Alert } from "./alert.js";
import { PlaidApiError, type PlaidClient } from "./plaid.js";
import { errorText, type BankLog } from "./log.js";
import type { TokenVault } from "./vault.js";

/**
 * The bank sync (card $2, ADR-27): for each connected bank, every change since its cursor
 * from Plaid's /transactions/sync, saved through money's Plaid import (posted only, matched by
 * Plaid's transaction id so a rerun never duplicates). The cursor moves only after the rows
 * are saved, so a failed run is retried in full the next time. Transactions the bank withdrew
 * are recorded for a person to check, never deleted. Any failure sends one phone alert.
 */
export interface SyncDeps {
  banks: Banks;
  money: Money;
  /** Made on first use, so a missing Plaid setting fails the run (and alerts) instead of the app. */
  plaid: () => PlaidClient;
  vault: TokenVault;
  alert: Alert;
  log: BankLog;
}

export interface SyncSummary {
  banks: number;
  failed: number;
  added: number;
  updated: number;
  withdrawn: number;
}

/** Plaid error codes that mean the login needs repairing through Link's update mode. */
const RECONNECT = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ACCESS_NOT_GRANTED"]);

const CHUNK = 5000; // money's import takes at most this many at once

export async function syncBanks(deps: SyncDeps, options: { householdId?: string } = {}): Promise<SyncSummary> {
  const summary: SyncSummary = { banks: 0, failed: 0, added: 0, updated: 0, withdrawn: 0 };
  const failures: string[] = [];

  let items: BankItem[];
  try {
    items = await deps.banks.itemsToSync(options.householdId);
  } catch (error) {
    deps.log.error(`Bank sync couldn't list the banks: ${errorText(error)}`);
    await sendAlert(deps, [`Couldn't start: ${errorText(error)}`]);
    throw error;
  }
  summary.banks = items.length;

  for (const item of items) {
    const name = item.institution ?? "A bank";
    let token = "";
    try {
      const plaid = deps.plaid();
      token = await deps.vault.read(item.accessTokenSecret);
      const changes = await plaid.syncTransactions(token, item.cursor);

      const report: ImportReport = { added: 0, updated: 0, skippedPending: 0, skippedUnknownAccount: 0, splitsCleared: 0, categorizedByRule: 0 };
      const all = [...changes.added, ...changes.modified];
      for (let start = 0; start === 0 || start < all.length; start += CHUNK) {
        const part = await deps.money.importPlaid(item.householdId, {
          accounts: start === 0 ? changes.accounts : [],
          transactions: all.slice(start, start + CHUNK),
        });
        for (const key of Object.keys(report) as (keyof ImportReport)[]) report[key] += part[key];
      }

      // Only now that the rows are saved does the cursor move.
      const withdrawn = await deps.banks.saveRun(item.id, {
        ok: true,
        cursor: changes.nextCursor,
        added: report.added,
        updated: report.updated,
        removedPlaidTransactionIds: changes.removed,
        plaidAccountIds: changes.accounts.map((a) => a.account_id),
        message: report.skippedUnknownAccount > 0 ? `${report.skippedUnknownAccount} transaction(s) were on an account Plaid didn't list.` : "OK",
      });

      summary.added += report.added;
      summary.updated += report.updated;
      summary.withdrawn += withdrawn;
      deps.log.info(`Bank sync ${name}: ${report.added} new, ${report.updated} updated, ${report.skippedPending} pending skipped, ${withdrawn} withdrawn`);
    } catch (error) {
      summary.failed++;
      const code = error instanceof PlaidApiError ? error.code : null;
      const message = errorText(error, [token]);
      const needsReconnect = code !== null && RECONNECT.has(code);
      deps.log.error(`Bank sync ${name} failed: ${message}`);
      try {
        await deps.banks.saveRun(item.id, { ok: false, errorCode: code, needsReconnect, message });
      } catch (saveError) {
        deps.log.error(`Bank sync ${name}: couldn't save the failed run: ${errorText(saveError, [token])}`);
      }
      failures.push(`${name}: ${message}${needsReconnect ? " Open Money, then Banks, and press Reconnect." : ""}`);
    }
  }

  if (failures.length > 0) await sendAlert(deps, failures);
  return summary;
}

async function sendAlert(deps: SyncDeps, lines: string[]): Promise<void> {
  try {
    await deps.alert("Kitchen bank sync failed", lines.join("\n"));
  } catch (error) {
    deps.log.error(`Bank sync couldn't send the phone alert: ${errorText(error)}`);
  }
}
