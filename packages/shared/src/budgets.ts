// Monthly category budgets (card $3, ADR-27). Amounts are whole cents. No envelope rollover:
// what's left of one month's budget doesn't move to the next.

/** One category's month. */
export interface MoneyBudgetLine {
  categoryId: string;
  category: string;
  /** Money out in the category that month, less refunds; negative when refunds outweigh it. */
  spentCents: number;
  /** Null when the category has no budget that month. */
  budgetCents: number | null;
  /** The month (`YYYY-MM`) the budget was set from; it carries forward until changed. */
  budgetFrom: string | null;
}

/** Response body of `GET /api/money/budgets?month=YYYY-MM` and `PUT /api/money/budgets/{categoryId}`. */
export interface MoneyMonthBudget {
  /** `YYYY-MM`. */
  month: string;
  /** Groceries first, then by name. */
  lines: MoneyBudgetLine[];
}

/** Body of `PUT /api/money/budgets/{categoryId}`: the budget from `month` onwards; null clears it. */
export interface MoneyBudgetChange {
  month: string;
  amountCents: number | null;
}
