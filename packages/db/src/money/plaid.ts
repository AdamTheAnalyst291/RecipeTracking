import { MoneyError } from "./errors.js";

/**
 * The fields used from a Plaid transaction (`/transactions/sync` added or modified). Plaid's
 * `amount` is in dollars and positive for money leaving the account.
 */
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name?: string | null | undefined;
  original_description?: string | null | undefined;
  pending: boolean;
}

/** The fields used from a Plaid account. */
export interface PlaidAccount {
  account_id: string;
  name: string;
  mask?: string | null | undefined;
}

/** A Plaid transaction as the kitchen stores it: cents, with money out negative. */
export interface ImportRow {
  plaidTransactionId: string;
  plaidAccountId: string;
  date: string;
  amountCents: number;
  payee: string;
  description: string;
}

const MAX_CENTS = 1e13;

/** Plaid dollars to kitchen cents: money out (Plaid positive) becomes negative. */
export function toCents(plaidAmount: number): number {
  if (!Number.isFinite(plaidAmount)) throw new MoneyError("invalid", "A transaction amount must be a number.");
  const cents = -Math.round(plaidAmount * 100);
  if (Math.abs(cents) >= MAX_CENTS) throw new MoneyError("invalid", "A transaction amount is too large.");
  return cents === 0 ? 0 : cents; // never -0
}

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const text = (value: string | null | undefined, max: number) => (value ?? "").trim().slice(0, max);

export function fromPlaid(tx: PlaidTransaction): ImportRow {
  const id = text(tx.transaction_id, 100);
  if (!id) throw new MoneyError("invalid", "A Plaid transaction has no transaction_id.");
  if (!isDay(tx.date)) throw new MoneyError("invalid", `Plaid transaction ${id} has a date that isn't a day.`);
  const name = text(tx.name, 500);
  return {
    plaidTransactionId: id,
    plaidAccountId: text(tx.account_id, 100),
    date: tx.date,
    amountCents: toCents(tx.amount),
    payee: text(tx.merchant_name, 200) || name.slice(0, 200),
    description: text(tx.original_description, 500) || name,
  };
}
