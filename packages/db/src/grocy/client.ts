/** What the importer needs from Grocy: read-only. There is deliberately no way to send anything else. */
export interface GrocyReader {
  /** GET a path under the Grocy URL, such as `/api/stock`. Throws GrocyHttpError on a non-2xx answer. */
  get(path: string): Promise<unknown>;
}

export class GrocyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Grocy answered ${status} for ${path}`);
    this.name = "GrocyHttpError";
  }
}

export interface GrocyClientOptions {
  /** Where Grocy lives, like http://localhost:9283. */
  baseUrl: string;
  /** A Grocy API key (Grocy, user menu, Manage API keys). */
  apiKey: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * A Grocy client that only ever sends GET: the request method is fixed here and is not a
 * parameter, so reading Grocy cannot change anything in it (ADR-25, card K5). It also never
 * sends the key anywhere but the Grocy server it was given.
 */
export function createGrocyClient({ baseUrl, apiKey, fetch: doFetch = fetch }: GrocyClientOptions): GrocyReader {
  const root = new URL(baseUrl);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("GROCY_URL must start with http:// or https://");
  return {
    async get(path) {
      if (!path.startsWith("/")) throw new Error(`Grocy path must start with /: ${path}`);
      const target = new URL(root.pathname.replace(/\/$/, "") + path, root); // keeps a sub-path like /grocy
      // A path like //other-host must never carry the key somewhere else.
      if (target.origin !== root.origin) throw new Error(`Grocy path leaves the Grocy server: ${path}`);
      const response = await doFetch(target.toString(), {
        method: "GET",
        redirect: "error", // a redirect must never carry the key to another host
        headers: { "GROCY-API-KEY": apiKey, Accept: "application/json" },
      });
      if (!response.ok) throw new GrocyHttpError(response.status, path);
      return response.json();
    },
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Everything read from Grocy, as raw Grocy JSON, plus what couldn't be read. */
export interface GrocyExport {
  products: Json[];
  units: Json[];
  /** One row per product that has stock (`product_id`, `amount`). */
  stock: Json[];
  /** Each product's price details (`last_price`, `last_purchased`), keyed by Grocy product id. */
  details: Record<string, Json>;
  /** Things that could not be read (a product whose details error, say). The import reports them. */
  problems: string[];
}

async function getList(reader: GrocyReader, path: string): Promise<Json[]> {
  const body = await reader.get(path);
  if (!Array.isArray(body)) throw new Error(`Unexpected answer from Grocy for ${path}`);
  return body.filter(isObject);
}

/** Reads all products, quantity units, current stock and each product's latest price. */
export async function readGrocy(reader: GrocyReader): Promise<GrocyExport> {
  const problems: string[] = [];
  const products = await getList(reader, "/api/objects/products");
  const units = await getList(reader, "/api/objects/quantity_units");
  const stock = await getList(reader, "/api/stock");
  const details: Record<string, Json> = {};
  for (const product of products) {
    const id = typeof product.id === "number" || typeof product.id === "string" ? String(product.id) : "";
    if (!/^\d+$/.test(id)) continue; // the import reports a product with no usable id
    try {
      const body = await reader.get(`/api/stock/products/${id}`);
      if (!isObject(body)) throw new Error("not product details");
      details[id] = body;
    } catch (error) {
      problems.push(`Product "${String(product.name ?? id)}": its price couldn't be read (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  return { products, units, stock, details, problems };
}
