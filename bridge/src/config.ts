// Settings come from the repo's .env, passed in by docker-compose.yml.
// Secrets (Plaid secret, Actual password) live only there, never in git.

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  port: Number(env('BRIDGE_PORT_INTERNAL', '8787')),
  dataDir: env('BRIDGE_DATA_DIR', '/data'),
  // Hour of the day (0-23, laptop time zone) for the daily bank sync.
  syncHour: Number(env('BANK_SYNC_HOUR', '6')),

  plaid: {
    clientId: env('PLAID_CLIENT_ID'),
    secret: env('PLAID_SECRET'),
    // sandbox while testing with fake banks, production for real ones.
    env: env('PLAID_ENV', 'production'),
    // Only needed if your bank logs in through its own site (OAuth).
    redirectUri: env('PLAID_REDIRECT_URI'),
  },

  actual: {
    serverUrl: env('ACTUAL_SERVER_URL', 'http://actual:5006'),
    password: env('ACTUAL_PASSWORD'),
    // Actual: Settings > Show advanced settings > Sync ID.
    syncId: env('ACTUAL_SYNC_ID'),
    // Only if the budget has end-to-end encryption turned on.
    budgetPassword: env('ACTUAL_BUDGET_PASSWORD'),
  },
};

export function missingSettings(): string[] {
  const missing: string[] = [];
  if (!config.plaid.clientId) missing.push('PLAID_CLIENT_ID');
  if (!config.plaid.secret) missing.push('PLAID_SECRET');
  if (!config.actual.password) missing.push('ACTUAL_PASSWORD');
  if (!config.actual.syncId) missing.push('ACTUAL_SYNC_ID');
  return missing;
}
