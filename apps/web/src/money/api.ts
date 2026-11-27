import type {
  ApiError,
  MoneyCategoriesResponse,
  MoneyCategory,
  MoneyRule,
  MoneyRulesApplied,
  MoneyRulesResponse,
  MoneySplitsChange,
  MoneyTransaction,
  MoneyTransactionsResponse,
  NewMoneyRule,
} from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the money screen needs from the API; tests swap in an in-memory one. */
export interface MoneyApi {
  transactions(options?: { uncategorized?: boolean }): Promise<MoneyTransaction[]>;
  setCategory(transactionId: string, categoryId: string | null): Promise<MoneyTransaction>;
  setSplits(transactionId: string, splits: MoneySplitsChange["splits"]): Promise<MoneyTransaction>;
  categories(): Promise<MoneyCategory[]>;
  addCategory(name: string): Promise<MoneyCategory>;
  rules(): Promise<MoneyRule[]>;
  addRule(rule: NewMoneyRule): Promise<MoneyRule>;
  removeRule(ruleId: string): Promise<void>;
  reorderRules(ruleIds: string[]): Promise<MoneyRule[]>;
  applyRules(): Promise<MoneyRulesApplied>;
}

/** A request the API refused or couldn't answer. `message` is fit to show the person. */
export class MoneyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createMoneyApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): MoneyApi {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined ? { method, headers: auth } : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}/api/money${path}`, init);
    } catch (error) {
      throw new MoneyApiError(0, error instanceof Error ? error.message : "Request failed");
    }
    if (response.ok) return response;
    const problem = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new MoneyApiError(response.status, typeof problem?.error === "string" ? problem.error : `HTTP ${response.status}`);
  }
  const json = async <T>(method: string, path: string, body?: unknown) => (await (await send(method, path, body)).json()) as T;

  return {
    async transactions(options = {}) {
      return (await json<MoneyTransactionsResponse>("GET", options.uncategorized ? "/transactions?uncategorized=true" : "/transactions")).transactions;
    },
    setCategory: (transactionId, categoryId) => json("PUT", `/transactions/${transactionId}/category`, { categoryId }),
    setSplits: (transactionId, splits) => json("PUT", `/transactions/${transactionId}/splits`, { splits } satisfies MoneySplitsChange),
    async categories() {
      return (await json<MoneyCategoriesResponse>("GET", "/categories")).categories;
    },
    addCategory: (name) => json("POST", "/categories", { name }),
    async rules() {
      return (await json<MoneyRulesResponse>("GET", "/rules")).rules;
    },
    addRule: (rule) => json("POST", "/rules", rule),
    async removeRule(ruleId) {
      await send("DELETE", `/rules/${ruleId}`);
    },
    async reorderRules(ruleIds) {
      return (await json<MoneyRulesResponse>("PUT", "/rule-order", { ruleIds })).rules;
    },
    applyRules: () => json("POST", "/apply-rules"),
  };
}
