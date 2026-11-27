import { MoneyError } from "./errors.js";

export interface SplitInput {
  categoryId: string;
  amountCents: number;
}

export const MAX_SPLITS = 20;

const dollars = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/**
 * Throws unless `splits` can replace a transaction's splits: either none (un-split), or two to
 * MAX_SPLITS whole-cent amounts, each with the transaction's sign, in different categories,
 * adding up exactly to `amountCents`.
 */
export function checkSplits(amountCents: number, splits: readonly SplitInput[]): void {
  if (splits.length === 0) return;
  if (splits.length < 2) throw new MoneyError("invalid", "A split needs at least two parts; to use one category, set the category instead.");
  if (splits.length > MAX_SPLITS) throw new MoneyError("invalid", `A transaction can be split at most ${MAX_SPLITS} ways.`);
  const seen = new Set<string>();
  let total = 0;
  for (const split of splits) {
    if (!Number.isSafeInteger(split.amountCents) || split.amountCents === 0) {
      throw new MoneyError("invalid", "Each split needs an amount in whole cents, not zero.");
    }
    if (Math.sign(split.amountCents) !== Math.sign(amountCents)) {
      throw new MoneyError("invalid", amountCents < 0 ? "Each split of money out must be money out too." : "Each split of money in must be money in too.");
    }
    const key = split.categoryId.toLowerCase();
    if (seen.has(key)) throw new MoneyError("invalid", "Each split needs a different category.");
    seen.add(key);
    total += split.amountCents;
  }
  if (total !== amountCents) {
    const gap = amountCents - total;
    throw new MoneyError(
      "invalid",
      `The splits must add up to the transaction: they come to ${dollars(total)}, ${dollars(gap)} ${Math.abs(total) > Math.abs(amountCents) ? "too much" : "short"}.`,
    );
  }
}
