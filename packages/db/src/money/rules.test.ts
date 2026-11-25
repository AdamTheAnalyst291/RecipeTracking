import { describe, expect, it } from "vitest";
import { pickCategory, type RuleLike } from "./rules.js";

const rule = (position: number, field: RuleLike["field"], match: RuleLike["match"], pattern: string, categoryId: string): RuleLike => ({
  position,
  field,
  match,
  pattern,
  categoryId,
});
const tx = (payee: string, description = payee) => ({ payee, description });

describe("pickCategory", () => {
  it("matches a payee exactly, ignoring case and extra spaces", () => {
    const rules = [rule(1, "payee", "equals", "sample grocer", "groceries")];
    expect(pickCategory(rules, tx("  Sample   GROCER "))).toBe("groceries");
    expect(pickCategory(rules, tx("Sample Grocer Express"))).toBeUndefined();
  });

  it("matches text anywhere in the payee or the description", () => {
    const rules = [rule(1, "description", "contains", "freshmart", "groceries"), rule(2, "payee", "contains", "bakery", "eating-out")];
    expect(pickCategory(rules, { payee: "Something", description: "FRESHMART 0042 MAIN ST" })).toBe("groceries");
    expect(pickCategory(rules, tx("Corner Bakery"))).toBe("eating-out");
    expect(pickCategory(rules, { payee: "Freshmart", description: "unrelated" })).toBeUndefined();
  });

  it("applies rules in order: the first match by position wins, whatever order they arrive in", () => {
    const rules = [rule(2, "payee", "contains", "grocer", "household"), rule(1, "payee", "contains", "sample", "groceries")];
    expect(pickCategory(rules, tx("Sample Grocer"))).toBe("groceries");
    expect(pickCategory([...rules].reverse(), tx("Sample Grocer"))).toBe("groceries");
    expect(pickCategory(rules, tx("Other Grocer"))).toBe("household");
  });

  it("returns nothing with no rules, and ignores a blank pattern", () => {
    expect(pickCategory([], tx("Sample Grocer"))).toBeUndefined();
    expect(pickCategory([rule(1, "payee", "contains", "   ", "x")], tx("Sample Grocer"))).toBeUndefined();
  });
});
