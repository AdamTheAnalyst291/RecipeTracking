// Daily bank sync: new posted Plaid transactions -> Actual Budget (ADR-22).
// The only Actual write here is importing bank transactions; imported_id
// makes reruns update rows instead of duplicating them.

import { api, withActual } from './actual.js';
import { postedFor } from './convert.js';
import { describePlaidError, fetchChanges } from './plaid.js';
import { isReady, loadState, saveState, type SyncRun } from './store.js';

let running: Promise<SyncRun> | null = null;

export function runSync(): Promise<SyncRun> {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<SyncRun> {
  const state = loadState();
  let imported = 0;
  let updated = 0;
  const notes: string[] = [];
  let ok = true;

  for (const item of state.items) {
    if (!isReady(item)) {
      notes.push(`${item.institution}: choose an Actual account for each bank account first`);
      continue;
    }
    try {
      const changes = await fetchChanges(item.accessToken, item.cursor);
      const accountMap = new Map(item.accounts.map((a) => [a.plaidAccountId, a.actualAccountId!]));
      const byAccount = postedFor([...changes.added, ...changes.modified], accountMap);

      await withActual(async () => {
        for (const [accountId, rows] of byAccount) {
          const result = await api.importTransactions(accountId, rows);
          if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
          imported += result.added.length;
          updated += result.updated.length;
        }
      });

      // Removed transactions are reported, not deleted: a person checks them.
      if (changes.removed.length) {
        notes.push(`${item.institution}: the bank withdrew ${changes.removed.length} transaction(s); check Actual by hand`);
      }

      // Move the cursor only after Actual has the rows, so a failure retries them.
      item.cursor = changes.nextCursor;
      saveState(state);
    } catch (err) {
      ok = false;
      notes.push(`${item.institution}: ${describePlaidError(err)}`);
    }
  }

  const run: SyncRun = {
    at: new Date().toISOString(),
    ok,
    imported,
    updated,
    message: notes.join(' | ') || (state.items.length ? 'OK' : 'No bank connected yet'),
  };
  const latest = loadState();
  latest.lastRun = run;
  saveState(latest);
  console.log(`[bank-sync] ${ok ? 'ok' : 'FAILED'}: ${imported} new, ${updated} updated. ${run.message}`);
  return run;
}

// Next run at syncHour local time, then every day after.
export function scheduleDaily(hour: number): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    runSync().catch((err) => console.error('[bank-sync]', err));
    scheduleDaily(hour);
  }, next.getTime() - now.getTime());
  console.log(`[bank-sync] next run ${next.toString()}`);
}
