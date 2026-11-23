import type { ApiError, PantryProduct, PantryProductChange, PantryResponse } from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type PantryResult<T> = { state: "ok"; value: T } | { state: "signed-out" } | { state: "error"; reason: string };

async function send<T>(fetchFn: Fetch, url: string, init: RequestInit, read: (body: unknown) => T): Promise<PantryResult<T>> {
  try {
    const response = await fetchFn(url, init);
    if (response.status === 401) return { state: "signed-out" };
    if (!response.ok) {
      // The API explains a refusal in { error }; anything else (a gateway page) is just the status.
      const body = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
      return { state: "error", reason: typeof body?.error === "string" ? body.error : `HTTP ${response.status}` };
    }
    return { state: "ok", value: read(await response.json()) };
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : "Request failed" };
  }
}

export function fetchPantry(
  apiUrl: string,
  getToken: () => Promise<string>,
  fetchFn: Fetch = fetch,
): Promise<PantryResult<PantryProduct[]>> {
  return getToken().then((token) =>
    send(fetchFn, `${apiUrl}/api/pantry/products`, { headers: { Authorization: `Bearer ${token}` } }, (body) => (body as PantryResponse).products),
  );
}

/** Changes stock, the staple flag and/or the price of one product; resolves to the product as it now stands. */
export function updateProduct(
  apiUrl: string,
  getToken: () => Promise<string>,
  id: string,
  change: PantryProductChange,
  fetchFn: Fetch = fetch,
): Promise<PantryResult<PantryProduct>> {
  return getToken().then((token) =>
    send(
      fetchFn,
      `${apiUrl}/api/pantry/products/${id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(change),
      },
      (body) => body as PantryProduct,
    ),
  );
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatPrice = (cents: number): string => dollars.format(cents / 100);

export const formatQuantity = (quantity: number, unit: string): string => `${quantity} ${unit}`;

/** Reads what someone typed as a price, like "2.49" or "$1,234.50"; undefined if it isn't a price in whole cents. */
export function dollarsToCents(text: string): number | undefined {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  return Math.round(Number(cleaned) * 100);
}
