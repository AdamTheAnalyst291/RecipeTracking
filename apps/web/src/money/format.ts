import type { MoneyRule } from "@kitchen/shared";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "−$84.37" for money out, "+$1,500.00" for money in. */
export function centsText(cents: number, { sign = true }: { sign?: boolean } = {}): string {
  const text = usd.format(Math.abs(cents) / 100);
  if (!sign || cents === 0) return text;
  return cents < 0 ? `−${text}` : `+${text}`;
}

/** A typed dollar amount ("24.37", "$1,024.5") as whole cents; undefined when it isn't one. */
export function dollarsToCents(typed: string): number | undefined {
  const clean = typed.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** "Payee contains “grocer” → Groceries". */
export function ruleText(rule: Pick<MoneyRule, "field" | "match" | "pattern" | "category">): string {
  const field = rule.field === "payee" ? "Payee" : "Description";
  const match = rule.match === "equals" ? "is" : "contains";
  return `${field} ${match} “${rule.pattern}” → ${rule.category}`;
}
