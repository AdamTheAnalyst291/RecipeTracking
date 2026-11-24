import { readFileSync } from "node:fs";

export interface GrocyFixture {
  quantityUnits: Record<string, unknown>[];
  products: Record<string, unknown>[];
  stock: Record<string, unknown>[];
  details: Record<string, Record<string, unknown>>;
}

/** The made-up export the tests use (never a real pantry). */
export function loadGrocyFixture(): GrocyFixture {
  return JSON.parse(readFileSync(new URL("../../test-fixtures/grocy-export.json", import.meta.url), "utf8")) as GrocyFixture;
}

export interface RecordedRequest {
  method: string | undefined;
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
  body: unknown;
}

/** A stand-in for Grocy's REST API, serving the fixture and recording every request it gets. Tests only. */
export function fakeGrocy(options: { fixture?: GrocyFixture } = {}) {
  const data = options.fixture ?? loadGrocyFixture();
  const requests: RecordedRequest[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method, url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect, body: init?.body });
    if (init?.method !== "GET") return json({ error_message: "read-only in tests" }, 405);
    if (url.pathname === "/api/objects/quantity_units") return json(data.quantityUnits);
    if (url.pathname === "/api/objects/products") return json(data.products);
    if (url.pathname === "/api/stock") return json(data.stock);
    const detail = /^\/api\/stock\/products\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const found = data.details[detail[1] ?? ""];
      return found ? json(found) : json({ error_message: "no details" }, 500);
    }
    return json({ error_message: "not found" }, 404);
  }) as typeof fetch;

  return { fetch: fetchFake, requests };
}
