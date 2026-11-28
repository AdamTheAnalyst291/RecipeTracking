import type { MoneyCategory, MoneyRule, MoneyTransaction } from "@kitchen/shared";
import { MoneyApiError, type MoneyApi } from "./api.js";

// Made-up transactions for the money screen tests; the repo is public.
const tx = (id: string, date: string, payee: string, amountCents: number, category: MoneyCategory | null = null): MoneyTransaction => ({
  id,
  accountId: "a1",
  account: "Everyday Checking",
  date,
  amountCents,
  payee,
  description: payee.toUpperCase(),
  plaidTransactionId: `tx-${id}`,
  categoryId: category?.id ?? null,
  category: category?.name ?? null,
  categorySource: category ? "rule" : null,
  splits: [],
});

export const sampleCategories = (): MoneyCategory[] => [
  { id: "c-groceries", name: "Groceries", kind: "spending" },
  { id: "c-household", name: "Household", kind: "spending" },
];

export const sampleTransactions = (): MoneyTransaction[] => [
  tx("t3", "2026-11-04", "Corner Bakery", -1250),
  tx("t2", "2026-11-03", "Payroll Example Co", 150000),
  tx("t1", "2026-11-02", "Sample Grocer", -8437, { id: "c-groceries", name: "Groceries", kind: "spending" }),
];

/** A money API held in memory, for the screen tests. Splits are checked the way the API checks them. */
export function inMemoryMoneyApi(): MoneyApi & { txs: MoneyTransaction[]; cats: MoneyCategory[]; ruleList: MoneyRule[] } {
  let next = 1;
  const api: ReturnType<typeof inMemoryMoneyApi> = {
    txs: sampleTransactions(),
    cats: sampleCategories(),
    ruleList: [],
    async transactions(options = {}) {
      const all = structuredClone(api.txs);
      return options.uncategorized ? all.filter((t) => t.categoryId === null && t.splits.length === 0) : all;
    },
    async setCategory(id, categoryId) {
      const t = api.txs.find((x) => x.id === id);
      if (!t) throw new MoneyApiError(404, "There's no such transaction.");
      const cat = api.cats.find((c) => c.id === categoryId);
      Object.assign(t, { categoryId: cat?.id ?? null, category: cat?.name ?? null, categorySource: cat ? "manual" : null, splits: [] });
      return structuredClone(t);
    },
    async setSplits(id, splits) {
      const t = api.txs.find((x) => x.id === id);
      if (!t) throw new MoneyApiError(404, "There's no such transaction.");
      const total = splits.reduce((sum, s) => sum + s.amountCents, 0);
      if (splits.length > 0 && total !== t.amountCents) throw new MoneyApiError(400, "The splits must add up to the transaction.");
      t.splits = splits.map((s) => ({ ...s, category: api.cats.find((c) => c.id === s.categoryId)?.name ?? "?" }));
      Object.assign(t, { categoryId: null, category: null, categorySource: null });
      return structuredClone(t);
    },
    async categories() {
      return structuredClone(api.cats);
    },
    async addCategory(name, kind = "spending") {
      const cat: MoneyCategory = { id: `c-new${next++}`, name: name.trim(), kind };
      api.cats.push(cat);
      return { ...cat };
    },
    async setCategoryKind(categoryId, kind) {
      const cat = api.cats.find((c) => c.id === categoryId);
      if (!cat) throw new MoneyApiError(404, "There's no such category.");
      cat.kind = kind;
      return { ...cat };
    },
    async rules() {
      return structuredClone(api.ruleList);
    },
    async addRule(rule) {
      const saved: MoneyRule = {
        ...rule,
        id: `r${next++}`,
        position: api.ruleList.length + 1,
        category: api.cats.find((c) => c.id === rule.categoryId)?.name ?? "?",
      };
      api.ruleList.push(saved);
      return { ...saved };
    },
    async removeRule(ruleId) {
      api.ruleList = api.ruleList.filter((r) => r.id !== ruleId);
    },
    async reorderRules(ruleIds) {
      api.ruleList = ruleIds.map((id, i) => ({ ...api.ruleList.find((r) => r.id === id)!, position: i + 1 }));
      return structuredClone(api.ruleList);
    },
    async applyRules() {
      let categorized = 0;
      for (const t of api.txs) {
        if (t.categorySource === "manual" || t.splits.length > 0) continue;
        const rule = api.ruleList.find((r) => (r.field === "payee" ? t.payee : t.description).toLowerCase().includes(r.pattern.toLowerCase()));
        if (rule && t.categoryId !== rule.categoryId) {
          Object.assign(t, { categoryId: rule.categoryId, category: rule.category, categorySource: "rule" });
          categorized++;
        }
      }
      return { categorized };
    },
  };
  return api;
}
