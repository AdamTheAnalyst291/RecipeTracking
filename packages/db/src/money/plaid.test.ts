import { describe, expect, it } from "vitest";
import { MoneyError } from "./errors.js";
import { fromPlaid, toCents, type PlaidTransaction } from "./plaid.js";

const base: PlaidTransaction = {
  transaction_id: "tx-1",
  account_id: "acc-1",
  date: "2026-11-02",
  amount: 84.37,
  name: "SAMPLE GROCER #12",
  merchant_name: "Sample Grocer",
  original_description: "SAMPLE GROCER #12 ANYTOWN",
  pending: false,
};

describe("toCents", () => {
  it("turns Plaid's dollars (positive leaves the account) into cents with money out negative", () => {
    expect(toCents(84.37)).toBe(-8437);
    expect(toCents(-1500)).toBe(150000);
    expect(toCents(0.1 + 0.2)).toBe(-30);
    expect(toCents(19.99)).toBe(-1999);
  });

  it("refuses an amount that isn't a finite number", () => {
    expect(() => toCents(Number.NaN)).toThrow(MoneyError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("fromPlaid", () => {
  it("uses the merchant as the payee and the original text as the description", () => {
    expect(fromPlaid(base)).toEqual({
      plaidTransactionId: "tx-1",
      plaidAccountId: "acc-1",
      date: "2026-11-02",
      amountCents: -8437,
      payee: "Sample Grocer",
      description: "SAMPLE GROCER #12 ANYTOWN",
    });
  });

  it("falls back to Plaid's name when there's no merchant or original text", () => {
    const row = fromPlaid({ ...base, merchant_name: null, original_description: undefined });
    expect(row.payee).toBe("SAMPLE GROCER #12");
    expect(row.description).toBe("SAMPLE GROCER #12");
  });

  it("refuses a transaction with no id or a date that isn't a day", () => {
    expect(() => fromPlaid({ ...base, transaction_id: "" })).toThrow(MoneyError);
    expect(() => fromPlaid({ ...base, date: "2026-13-02" })).toThrow(MoneyError);
  });
});
