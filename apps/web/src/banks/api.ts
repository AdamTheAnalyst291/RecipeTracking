import type { ApiError, BankLinkToken, BankSyncSummary, BanksResponse, ConnectedBank } from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the Banks screen needs from the API; tests swap in an in-memory one. */
export interface BanksApi {
  banks(): Promise<BanksResponse>;
  /** For a new bank, or with a bank id for update mode ("Reconnect"). */
  linkToken(bankId?: string): Promise<string>;
  connect(publicToken: string, institution: string | null): Promise<ConnectedBank>;
  syncNow(): Promise<BankSyncSummary>;
  /** Plaid Sandbox only: makes the bank's login need repairing. */
  sandboxResetLogin(bankId: string): Promise<void>;
}

/** A request the API refused or couldn't answer. `message` is fit to show the person. */
export class BanksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createBanksApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): BanksApi {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined ? { method, headers: auth } : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}/api/money${path}`, init);
    } catch (error) {
      throw new BanksApiError(0, error instanceof Error ? error.message : "Request failed");
    }
    if (response.ok) return response;
    const problem = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new BanksApiError(response.status, typeof problem?.error === "string" ? problem.error : `HTTP ${response.status}`);
  }
  const json = async <T>(method: string, path: string, body?: unknown) => (await (await send(method, path, body)).json()) as T;

  return {
    banks: () => json("GET", "/banks"),
    async linkToken(bankId) {
      return (await json<BankLinkToken>("POST", "/bank-link-token", bankId ? { bankId } : {})).linkToken;
    },
    connect: (publicToken, institution) => json("POST", "/banks", { publicToken, institution }),
    syncNow: () => json("POST", "/bank-sync"),
    async sandboxResetLogin(bankId) {
      await send("POST", `/banks/${bankId}/sandbox-reset-login`);
    },
  };
}
