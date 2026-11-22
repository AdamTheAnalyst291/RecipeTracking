import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type Transaction,
  type RemovedTransaction,
} from 'plaid';
import { config } from './config.js';

let client: PlaidApi | null = null;

export function plaid(): PlaidApi {
  if (!client) {
    const basePath = PlaidEnvironments[config.plaid.env];
    if (!basePath) throw new Error(`PLAID_ENV must be sandbox or production, not "${config.plaid.env}"`);
    client = new PlaidApi(
      new Configuration({
        basePath,
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': config.plaid.clientId,
            'PLAID-SECRET': config.plaid.secret,
          },
        },
      }),
    );
  }
  return client;
}

// With an access token, Link opens in update mode to repair an existing
// connection (same item, same transaction ids) instead of making a new one.
export async function createLinkToken(accessToken?: string): Promise<string> {
  const res = await plaid().linkTokenCreate({
    client_name: 'Kitchen bridge',
    language: 'en',
    country_codes: [CountryCode.Us],
    user: { client_user_id: 'home' },
    ...(accessToken ? { access_token: accessToken } : { products: [Products.Transactions] }),
    ...(config.plaid.redirectUri ? { redirect_uri: config.plaid.redirectUri } : {}),
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string) {
  const { data } = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  const accounts = await plaid().accountsGet({ access_token: data.access_token });
  return { itemId: data.item_id, accessToken: data.access_token, accounts: accounts.data.accounts };
}

// Every change since the cursor, paging until Plaid says there's no more.
export async function fetchChanges(accessToken: string, cursor: string | null) {
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];
  let next = cursor ?? undefined;
  for (;;) {
    const { data } = await plaid().transactionsSync({ access_token: accessToken, cursor: next, count: 500 });
    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed);
    next = data.next_cursor;
    if (!data.has_more) break;
  }
  return { added, modified, removed, nextCursor: next ?? null };
}

// Plaid errors carry a useful code (e.g. ITEM_LOGIN_REQUIRED) in the response body.
export function describePlaidError(err: unknown): string {
  const body = (err as { response?: { data?: { error_code?: string; error_message?: string } } }).response?.data;
  if (body?.error_code) return `${body.error_code}: ${body.error_message ?? ''}`.trim();
  return err instanceof Error ? err.message : String(err);
}
