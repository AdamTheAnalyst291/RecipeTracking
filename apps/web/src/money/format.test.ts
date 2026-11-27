import { describe, expect, it } from "vitest";
import { centsText, dollarsToCents, ruleText } from "./format.js";

describe("centsText", () => {
  it("shows money out with a minus and money in with a plus", () => {
    expect(centsText(-8437)).toBe("−$84.37");
    expect(centsText(150000)).toBe("+$1,500.00");
    expect(centsText(-5)).toBe("−$0.05");
    expect(centsText(0)).toBe("$0.00");
  });
  it("leaves the sign off when asked", () => {
    expect(centsText(-8437, { sign: false })).toBe("$84.37");
  });
});

describe("dollarsToCents", () => {
  it("reads a typed amount as whole cents", () => {
    expect(dollarsToCents("60")).toBe(6000);
    expect(dollarsToCents(" 24.37 ")).toBe(2437);
    expect(dollarsToCents("$1,024.5")).toBe(102450);
    expect(dollarsToCents("0.1")).toBe(10);
  });
  it("gives undefined for what isn't an amount", () => {
    expect(dollarsToCents("")).toBeUndefined();
    expect(dollarsToCents("abc")).toBeUndefined();
    expect(dollarsToCents("1.234")).toBeUndefined();
    expect(dollarsToCents("-5")).toBeUndefined();
  });
});

describe("ruleText", () => {
  it("reads a rule as a sentence", () => {
    expect(ruleText({ field: "payee", match: "contains", pattern: "grocer", category: "Groceries" })).toBe("Payee contains “grocer” → Groceries");
    expect(ruleText({ field: "description", match: "equals", pattern: "x", category: "Fun" })).toBe("Description is “x” → Fun");
  });
});
