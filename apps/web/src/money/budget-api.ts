import type { ApiError, MoneyBudgetChange, MoneyMonthBudget } from "@kitchen/shared";
import { MoneyApiError } from "./api.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the budget view needs from the API (card $3); tests swap in an in-memory one. */
export interface BudgetApi {
  /** Spend vs budget for a month, `YYYY-MM`. */
  month(month: string): Promise<MoneyMonthBudget>;
  /** Sets a category's budget from `month` on (null clears it); returns that month. */
  setBudget(categoryId: string, month: string, amountCents: number | null): Promise<MoneyMonthBudget>;
}

export function createBudgetApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): BudgetApi {
  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined ? { method, headers: auth } : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}/api/money/budgets${path}`, init);
    } catch (error) {
      throw new MoneyApiError(0, error instanceof Error ? error.message : "Request failed");
    }
    if (response.ok) return (await response.json()) as T;
    const problem = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new MoneyApiError(response.status, typeof problem?.error === "string" ? problem.error : `HTTP ${response.status}`);
  }

  return {
    month: (month) => send("GET", `?month=${encodeURIComponent(month)}`),
    setBudget: (categoryId, month, amountCents) => send("PUT", `/${encodeURIComponent(categoryId)}`, { month, amountCents } satisfies MoneyBudgetChange),
  };
}
