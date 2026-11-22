// Kitchen bridge web server. For now it only does bank sync: a page to
// connect a bank through Plaid Link once, and a daily import into Actual.
// docker-compose.yml publishes it on 127.0.0.1 only, so just this laptop can open it.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listAccounts } from './actual.js';
import { config, missingSettings } from './config.js';
import { createLinkToken, describePlaidError, exchangePublicToken } from './plaid.js';
import { loadState, saveState } from './store.js';
import { runSync, scheduleDaily } from './sync.js';

const page = readFileSync(new URL('../public/index.html', import.meta.url));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('Request too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function status() {
  const state = loadState();
  const missing = missingSettings();
  let actualAccounts: { id: string; name: string }[] = [];
  let actualError = '';
  if (!missing.includes('ACTUAL_PASSWORD') && !missing.includes('ACTUAL_SYNC_ID')) {
    try {
      actualAccounts = await listAccounts();
    } catch (err) {
      actualError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    missing,
    actualAccounts,
    actualError,
    lastRun: state.lastRun,
    // Never send access tokens to the page.
    items: state.items.map(({ itemId, institution, accounts }) => ({ itemId, institution, accounts })),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());

  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  // A custom header can't be sent cross-site without a CORS preflight, which
  // this server never approves, so other websites can't call these endpoints.
  if (req.headers['x-bridge'] !== '1') return send(res, 403, { error: 'Missing X-Bridge header' });
  const body = await readJson(req);

  switch (url.pathname) {
    case '/api/link-token': {
      const item = body.itemId ? loadState().items.find((i) => i.itemId === body.itemId) : undefined;
      if (body.itemId && !item) return send(res, 404, { error: 'Unknown bank connection' });
      return send(res, 200, { linkToken: await createLinkToken(item?.accessToken) });
    }

    case '/api/exchange': {
      const linked = await exchangePublicToken(String(body.publicToken ?? ''));
      const state = loadState();
      state.items = state.items.filter((i) => i.itemId !== linked.itemId);
      state.items.push({
        itemId: linked.itemId,
        accessToken: linked.accessToken,
        institution: String(body.institution ?? 'Bank'),
        cursor: null,
        accounts: linked.accounts.map((a) => ({
          plaidAccountId: a.account_id,
          name: a.official_name || a.name,
          mask: a.mask,
          actualAccountId: null,
        })),
      });
      saveState(state);
      return send(res, 200, { ok: true });
    }

    case '/api/map': {
      const state = loadState();
      const account = state.items
        .find((i) => i.itemId === body.itemId)
        ?.accounts.find((a) => a.plaidAccountId === body.plaidAccountId);
      if (!account) return send(res, 404, { error: 'Unknown account' });
      account.actualAccountId = body.actualAccountId ? String(body.actualAccountId) : null;
      saveState(state);
      return send(res, 200, { ok: true });
    }

    case '/api/sync':
      return send(res, 200, await runSync());
  }
  return send(res, 404, { error: 'Not found' });
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[bridge]', describePlaidError(err));
    if (!res.headersSent) send(res, 500, { error: describePlaidError(err) });
  });
}).listen(config.port, () => {
  console.log(`[bridge] listening on ${config.port}`);
  const missing = missingSettings();
  if (missing.length) console.log(`[bridge] bank sync is off until .env has: ${missing.join(', ')}`);
  else scheduleDaily(config.syncHour);
});
