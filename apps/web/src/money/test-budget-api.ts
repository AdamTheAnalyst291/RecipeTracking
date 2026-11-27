import type { MoneyBudgetLine, MoneyMonthBudget } from "@kitchen/shared";
import type { BudgetApi } from "./budget-api.js";

// Made-up spending for the budget view tests; the repo is public.
const names: Record<string, string> = { "c-groceries": "Groceries", "c-household": "Household", "c-books": "Books" };

/** A budget API held in memory. Budgets carry forward from the month they're set, as the API does. */
export function inMemoryBudgetApi(): BudgetApi & { calls: [string, string, number | null][] } {
  const spent: Record<string, Record<string, number>> = {
    "2026-11": { "c-groceries": 41250, "c-household": 3500 },
    "2026-10": { "c-groceries": 125000 },
  };
  const set: { categoryId: string; month: string; amountCents: number | null }[] = [{ categoryId: "c-groceries", month: "2026-10", amountCents: 60000 }];

  function report(month: string): MoneyMonthBudget {
    const lines: MoneyBudgetLine[] = [];
    for (const categoryId of Object.keys(names)) {
      const latest = set.filter((b) => b.categoryId === categoryId && b.month <= month).sort((a, b) => b.month.localeCompare(a.month))[0];
      const budgetCents = latest?.amountCents ?? null;
      const spentCents = spent[month]?.[categoryId] ?? 0;
      if (categoryId !== "c-groceries" && budgetCents === null && spentCents <= 0) continue;
      lines.push({ categoryId, category: names[categoryId]!, spentCents, budgetCents, budgetFrom: budgetCents === null ? null : latest!.month });
    }
    return { month, lines };
  }

  const api: ReturnType<typeof inMemoryBudgetApi> = {
    calls: [],
    async month(month) {
      return report(month);
    },
    async setBudget(categoryId, month, amountCents) {
      api.calls.push([categoryId, month, amountCents]);
      const i = set.findIndex((b) => b.categoryId === categoryId && b.month === month);
      if (i >= 0) set[i]!.amountCents = amountCents;
      else set.push({ categoryId, month, amountCents });
      return report(month);
    },
  };
  return api;
}
