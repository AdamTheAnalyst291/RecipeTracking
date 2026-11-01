// Plaid transaction -> Actual import row. Kept free of I/O so it can be tested.

import type { Transaction } from 'plaid';

export type ActualImportRow = {
  account: string;
  date: string;
  amount: number;
  payee_name: string;
  imported_payee: string;
  imported_id: string;
  cleared: boolean;
};

// Plaid amounts are positive for money leaving the account; Actual stores
// integer cents with outflows negative.
export function toCents(plaidAmount: number): number {
  return -Math.round(plaidAmount * 100);
}

export function toActual(tx: Transaction, actualAccountId: string): ActualImportRow {
  const description = tx.original_description || tx.name;
  return {
    account: actualAccountId,
    date: tx.date,
    amount: toCents(tx.amount),
    payee_name: tx.merchant_name || tx.name,
    imported_payee: description,
    // Plaid's id is stable across syncs, so re-imports update instead of duplicating.
    imported_id: `plaid:${tx.transaction_id}`,
    cleared: true,
  };
}

// Pending transactions change id when they post, so only posted ones are imported.
export function postedFor(
  txs: Transaction[],
  accountMap: Map<string, string>,
): Map<string, ActualImportRow[]> {
  const byAccount = new Map<string, ActualImportRow[]>();
  for (const tx of txs) {
    if (tx.pending) continue;
    const target = accountMap.get(tx.account_id);
    if (!target || target === 'skip') continue;
    const rows = byAccount.get(target) ?? [];
    rows.push(toActual(tx, target));
    byAccount.set(target, rows);
  }
  return byAccount;
}
