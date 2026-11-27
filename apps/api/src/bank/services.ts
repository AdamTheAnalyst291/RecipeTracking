import type { BankServices } from "../functions/banks.js";
import { createAlert } from "./alert.js";
import { createPlaidClient, plaidConfigFrom, type PlaidClient } from "./plaid.js";
import { createKeyVault } from "./vault.js";

/**
 * Plaid, Key Vault and the phone alert from the app settings: `PLAID_ENV` (sandbox in Dev,
 * production in Prod), `PLAID_CLIENT_ID` and `PLAID_SECRET` (Key Vault references),
 * `KITCHEN_KEY_VAULT_URI`, and `KITCHEN_ALERT_NTFY_TOPIC` (a Key Vault reference).
 */
export function bankServices(env: Record<string, string | undefined> = process.env): BankServices {
  let plaid: PlaidClient | undefined;
  return {
    plaid: () => (plaid ??= createPlaidClient(plaidConfigFrom(env))),
    vault: createKeyVault(env),
    alert: createAlert(env),
  };
}
