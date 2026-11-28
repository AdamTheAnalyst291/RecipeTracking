// Money (card $1, ADR-27). Amounts are whole cents: money out of an account is negative,
// money in positive.

export interface MoneyAccount {
  id: string;
  name: string;
  /** The last digits the bank shows, never the full number. */
  mask: string | null;
}

/**
 * `spending` counts towards spend vs budget; `not-spending` is for transfers, pay and other
 * income, which budgets leave out entirely (card $6).
 */
export type MoneyCategoryKind = "spending" | "not-spending";

export interface MoneyCategory {
  id: string;
  name: string;
  kind: MoneyCategoryKind;
}

/** Body of `POST /api/money/categories`; `kind` defaults to spending. */
export interface NewMoneyCategory {
  name: string;
  kind?: MoneyCategoryKind;
}

/** Body of `PATCH /api/money/categories/{id}`: a new name, a new kind, or both. */
export interface MoneyCategoryChange {
  name?: string;
  kind?: MoneyCategoryKind;
}

export interface MoneySplit {
  categoryId: string;
  category: string;
  amountCents: number;
}

export interface MoneyTransaction {
  id: string;
  accountId: string;
  account: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  payee: string;
  description: string;
  plaidTransactionId: string | null;
  /** Null when uncategorized or split. */
  categoryId: string | null;
  category: string | null;
  /** `rule`: set by a rule. `manual`: set by a person; rules never change it. */
  categorySource: "rule" | "manual" | null;
  /** Empty unless split; then the amounts add up to `amountCents`. */
  splits: MoneySplit[];
}

export type MoneyRuleField = "payee" | "description";
export type MoneyRuleMatch = "equals" | "contains";

export interface MoneyRule {
  id: string;
  /** Rules run in this order; the first that matches wins. */
  position: number;
  field: MoneyRuleField;
  match: MoneyRuleMatch;
  pattern: string;
  categoryId: string;
  category: string;
}

/** Body of `POST /api/money/rules` and `PUT /api/money/rules/{id}`. */
export interface NewMoneyRule {
  field: MoneyRuleField;
  match: MoneyRuleMatch;
  pattern: string;
  categoryId: string;
}

/** Response of `GET /api/money/transactions` (`?uncategorized=true`, `?limit=`). */
export interface MoneyTransactionsResponse {
  transactions: MoneyTransaction[];
}
export interface MoneyAccountsResponse {
  accounts: MoneyAccount[];
}
export interface MoneyCategoriesResponse {
  categories: MoneyCategory[];
}
export interface MoneyRulesResponse {
  rules: MoneyRule[];
}

/** Body of `PUT /api/money/transactions/{id}/category`; null clears it. */
export interface MoneyCategoryChoice {
  categoryId: string | null;
}

/** Body of `PUT /api/money/transactions/{id}/splits`; an empty list un-splits. */
export interface MoneySplitsChange {
  splits: { categoryId: string; amountCents: number }[];
}

/** Body of `PUT /api/money/rule-order`: every rule id once, in the new order. */
export interface MoneyRuleOrder {
  ruleIds: string[];
}

/** Response of `POST /api/money/apply-rules`. */
export interface MoneyRulesApplied {
  categorized: number;
}
