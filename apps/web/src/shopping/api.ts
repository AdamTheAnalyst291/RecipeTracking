import type {
  ApiError,
  NewShoppingItem,
  NewShoppingList,
  ShoppingItem,
  ShoppingList,
  ShoppingListResponse,
} from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the shopping screen needs from the API; tests swap in an in-memory one. */
export interface ShoppingApi {
  /** The most recent list, or null before the first one is made. */
  latest(): Promise<ShoppingList | null>;
  /** Builds a new list from the meal plan; with no dates it covers the coming week. */
  generate(dates?: NewShoppingList): Promise<ShoppingList>;
  addItem(listId: string, item: NewShoppingItem): Promise<ShoppingItem>;
  setChecked(listId: string, itemId: string, checked: boolean): Promise<ShoppingItem>;
  removeItem(listId: string, itemId: string): Promise<void>;
}

/** A request the API refused or couldn't answer. `message` is fit to show the person. */
export class ShoppingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createShoppingApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): ShoppingApi {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined
          ? { method, headers: auth }
          : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}${path}`, init);
    } catch (error) {
      throw new ShoppingApiError(0, error instanceof Error ? error.message : "Request failed");
    }
    if (response.ok) return response;
    const problem = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new ShoppingApiError(response.status, typeof problem?.error === "string" ? problem.error : `HTTP ${response.status}`);
  }

  return {
    async latest() {
      return ((await (await send("GET", "/api/shopping-list")).json()) as ShoppingListResponse).list;
    },
    async generate(dates = {}) {
      return (await (await send("POST", "/api/shopping-list", dates)).json()) as ShoppingList;
    },
    async addItem(listId, item) {
      return (await (await send("POST", `/api/shopping-list/${listId}/items`, item)).json()) as ShoppingItem;
    },
    async setChecked(listId, itemId, checked) {
      return (await (await send("PATCH", `/api/shopping-list/${listId}/items/${itemId}`, { checked })).json()) as ShoppingItem;
    },
    async removeItem(listId, itemId) {
      await send("DELETE", `/api/shopping-list/${listId}/items/${itemId}`);
    },
  };
}
