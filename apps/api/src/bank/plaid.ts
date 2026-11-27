import type { PlaidAccount, PlaidTransaction } from "@kitchen/db";

/**
 * A small client for the few Plaid endpoints the bank sync uses (card $2), over fetch. Which
 * Plaid environment and which keys come from configuration: Sandbox in Dev, Production in
 * Prod, with the keys read from Key Vault through Key Vault references.
 */

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidConfig {
  environment: PlaidEnvironment;
  clientId: string;
  secret: string;
}

/** Everything that changed since a cursor. */
export interface PlaidChanges {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  /** Ids of transactions the bank withdrew (including pending ones that have since posted). */
  removed: string[];
  accounts: PlaidAccount[];
  nextCursor: string;
}

export interface PlaidClient {
  readonly environment: PlaidEnvironment;
  /** A Link token: for a new connection, or with an access token for update mode ("Reconnect"). */
  createLinkToken(options: { userId: string; accessToken?: string }): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ itemId: string; accessToken: string }>;
  accounts(accessToken: string): Promise<PlaidAccount[]>;
  /** Every change since `cursor` (null for the first sync), paging until Plaid has no more. */
  syncTransactions(accessToken: string, cursor: string | null): Promise<PlaidChanges>;
  /** Sandbox only: makes the login need repairing, to try a failure and Reconnect. */
  sandboxResetLogin(accessToken: string): Promise<void>;
}

/** An error Plaid answered with. The message is Plaid's code and text, never what was sent. */
export class PlaidApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly type: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PlaidApiError";
  }
}

const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** Plaid isn't configured in this environment. The message names a setting, never a value. */
export class PlaidConfigError extends Error {
  override name = "PlaidConfigError";
}

/** Reads `PLAID_ENV`, `PLAID_CLIENT_ID` and `PLAID_SECRET`; errors name a setting, never a value. */
export function plaidConfigFrom(env: Record<string, string | undefined>): PlaidConfig {
  const environment = env.PLAID_ENV?.trim();
  if (environment !== "sandbox" && environment !== "production") throw new PlaidConfigError("PLAID_ENV must be sandbox or production");
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  if (!clientId) throw new PlaidConfigError("PLAID_CLIENT_ID is not set");
  if (!secret) throw new PlaidConfigError("PLAID_SECRET is not set");
  return { environment, clientId, secret };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const PAGE = 500;
const MAX_RESTARTS = 3;

const account = (a: { account_id: string; name: string; mask?: string | null }): PlaidAccount => ({ account_id: a.account_id, name: a.name, mask: a.mask ?? null });

export function createPlaidClient(config: PlaidConfig, fetchFn: Fetch = fetch): PlaidClient {
  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchFn(`${HOSTS[config.environment]}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
    const json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!response.ok) {
      const text = (key: string, fallback: string) => (typeof json?.[key] === "string" ? (json[key] as string) : fallback);
      throw new PlaidApiError(response.status, text("error_code", `HTTP_${response.status}`), text("error_type", "UNKNOWN"), text("error_message", "Plaid refused the request."));
    }
    if (!json) throw new PlaidApiError(response.status, "INVALID_RESPONSE", "UNKNOWN", "Plaid's answer wasn't JSON.");
    return json as T;
  }

  interface SyncPage {
    added: PlaidTransaction[];
    modified: PlaidTransaction[];
    removed: { transaction_id: string }[];
    accounts?: { account_id: string; name: string; mask?: string | null }[];
    next_cursor: string;
    has_more: boolean;
  }

  return {
    environment: config.environment,

    async createLinkToken({ userId, accessToken }) {
      const { link_token } = await call<{ link_token: string }>("/link/token/create", {
        client_name: "Kitchen",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: userId },
        ...(accessToken ? { access_token: accessToken } : { products: ["transactions"] }),
      });
      return link_token;
    },

    async exchangePublicToken(publicToken) {
      const r = await call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
      return { itemId: r.item_id, accessToken: r.access_token };
    },

    async accounts(accessToken) {
      const r = await call<{ accounts: { account_id: string; name: string; mask?: string | null }[] }>("/accounts/get", { access_token: accessToken });
      return r.accounts.map(account);
    },

    async syncTransactions(accessToken, cursor) {
      for (let attempt = 0; ; attempt++) {
        const changes: PlaidChanges = { added: [], modified: [], removed: [], accounts: [], nextCursor: cursor ?? "" };
        const accounts = new Map<string, PlaidAccount>();
        let next = cursor;
        try {
          for (;;) {
            const page = await call<SyncPage>("/transactions/sync", { access_token: accessToken, count: PAGE, ...(next ? { cursor: next } : {}) });
            changes.added.push(...page.added);
            changes.modified.push(...page.modified);
            changes.removed.push(...page.removed.map((r) => r.transaction_id));
            for (const a of page.accounts ?? []) accounts.set(a.account_id, account(a));
            next = page.next_cursor;
            if (!page.has_more) break;
          }
        } catch (error) {
          // Plaid's data changed while paging: start again from the cursor we began with.
          if (error instanceof PlaidApiError && error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < MAX_RESTARTS) continue;
          throw error;
        }
        changes.accounts = [...accounts.values()];
        changes.nextCursor = next ?? "";
        return changes;
      }
    },

    async sandboxResetLogin(accessToken) {
      if (config.environment !== "sandbox") throw new Error("Resetting a login only works in Plaid Sandbox.");
      await call("/sandbox/item/reset_login", { access_token: accessToken });
    },
  };
}
