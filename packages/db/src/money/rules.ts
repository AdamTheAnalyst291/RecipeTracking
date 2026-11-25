/** What a rule looks at: the payee, or the bank's description text. */
export type RuleField = "payee" | "description";
/** `equals`: the whole field. `contains`: anywhere in it. Both ignore case and extra spaces. */
export type RuleMatch = "equals" | "contains";

export interface RuleLike {
  position: number;
  field: RuleField;
  match: RuleMatch;
  pattern: string;
  categoryId: string;
}

const normal = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function matches(rule: RuleLike, tx: { payee: string; description: string }): boolean {
  const pattern = normal(rule.pattern);
  if (pattern === "") return false;
  const value = normal(rule.field === "payee" ? tx.payee : tx.description);
  return rule.match === "equals" ? value === pattern : value.includes(pattern);
}

/** The category of the first rule, by position, that matches the transaction; undefined when none does. */
export function pickCategory(rules: readonly RuleLike[], tx: { payee: string; description: string }): string | undefined {
  return [...rules].sort((a, b) => a.position - b.position).find((r) => matches(r, tx))?.categoryId;
}
