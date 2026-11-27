import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

/**
 * Where Plaid access tokens live: Key Vault, written and read with the Functions app's managed
 * identity (locally, `az login`). Never the database, a log or a response (ADR-27).
 */
export interface TokenVault {
  save(name: string, value: string): Promise<void>;
  read(name: string): Promise<string>;
  /**
   * Proves the vault can be written before a new bank is connected: a Plaid Trial slot is used
   * up by connecting, so a token that then couldn't be stored would waste one for good.
   */
  checkWritable(): Promise<void>;
}

/** The Key Vault secret name for an item's access token (letters, digits and dashes). */
export function accessTokenSecretName(plaidItemId: string): string {
  const safe = plaidItemId.replace(/[^A-Za-z0-9-]/g, "-");
  if (!/[A-Za-z0-9]/.test(safe)) throw new Error("A Plaid item id has no letters or digits");
  return `plaid-access-token-${safe}`.slice(0, 127);
}

const CHECK_SECRET = "plaid-vault-write-check";

/** The environment's Key Vault, from `KITCHEN_KEY_VAULT_URI`. */
export function createKeyVault(env: Record<string, string | undefined> = process.env): TokenVault {
  let client: SecretClient | undefined;
  const secrets = () => {
    if (!client) {
      const uri = env.KITCHEN_KEY_VAULT_URI?.trim();
      if (!uri) throw new Error("KITCHEN_KEY_VAULT_URI is not set");
      client = new SecretClient(uri, new DefaultAzureCredential());
    }
    return client;
  };
  return {
    async save(name, value) {
      await secrets().setSecret(name, value, { contentType: "Plaid access token" });
    },
    async read(name) {
      const secret = await secrets().getSecret(name);
      if (!secret.value) throw new Error(`Key Vault secret ${name} has no value`);
      return secret.value;
    },
    async checkWritable() {
      await secrets().setSecret(CHECK_SECRET, new Date().toISOString(), { contentType: "Write check before connecting a bank; not secret" });
    },
  };
}
