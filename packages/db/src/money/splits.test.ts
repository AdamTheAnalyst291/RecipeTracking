import { describe, expect, it } from "vitest";
import { MoneyError } from "./errors.js";
import { checkSplits } from "./splits.js";

const s = (categoryId: string, amountCents: number) => ({ categoryId, amountCents });
const refusal = (fn: () => void): MoneyError | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MoneyError) return e;
    throw e;
  }
  return undefined;
};

describe("checkSplits", () => {
  it("accepts splits that add up to the transaction", () => {
    expect(() => checkSplits(-8437, [s("a", -6000), s("b", -2437)])).not.toThrow();
    expect(() => checkSplits(150000, [s("a", 100000), s("b", 50000)])).not.toThrow();
  });

  it("accepts no splits at all, which un-splits the transaction", () => {
    expect(() => checkSplits(-8437, [])).not.toThrow();
  });

  it("refuses splits that don't add up, saying by how much", () => {
    const e = refusal(() => checkSplits(-8437, [s("a", -6000), s("b", -2400)]));
    expect(e?.code).toBe("invalid");
    expect(e?.message).toMatch(/add up/);
    expect(e?.message).toMatch(/0\.37/);
  });

  it("refuses a single split, a zero or fractional amount, a sign that differs from the transaction, and a repeated category", () => {
    expect(refusal(() => checkSplits(-100, [s("a", -100)]))?.code).toBe("invalid");
    expect(refusal(() => checkSplits(-100, [s("a", -100), s("b", 0)]))?.code).toBe("invalid");
    expect(refusal(() => checkSplits(-100, [s("a", -50.5), s("b", -49.5)]))?.code).toBe("invalid");
    expect(refusal(() => checkSplits(-100, [s("a", -150), s("b", 50)]))?.code).toBe("invalid");
    expect(refusal(() => checkSplits(-100, [s("a", -50), s("a", -50)]))?.code).toBe("invalid");
  });

  it("refuses too many splits", () => {
    const many = Array.from({ length: 21 }, (_, i) => s(`c${i}`, -1));
    expect(refusal(() => checkSplits(-21, many))?.code).toBe("invalid");
  });
});
