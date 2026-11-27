import { describe, expect, it } from "vitest";
import { accessTokenSecretName, tokenVaultUri } from "./vault.js";

describe("the token vault", () => {
  it("is the vault named by KITCHEN_TOKEN_VAULT_NAME, never the main vault's address", () => {
    expect(tokenVaultUri({ KITCHEN_TOKEN_VAULT_NAME: "kv-kitchen-dev-abc123-t", KITCHEN_KEY_VAULT_URI: "https://kv-kitchen-dev-abc123.vault.azure.net/" })).toBe(
      "https://kv-kitchen-dev-abc123-t.vault.azure.net/",
    );
  });

  it("refuses to guess when the name is missing or isn't a vault name", () => {
    expect(() => tokenVaultUri({ KITCHEN_KEY_VAULT_URI: "https://kv-kitchen-dev-abc123.vault.azure.net/" })).toThrow(/KITCHEN_TOKEN_VAULT_NAME/);
    expect(() => tokenVaultUri({ KITCHEN_TOKEN_VAULT_NAME: "evil.example.com/x" })).toThrow(/KITCHEN_TOKEN_VAULT_NAME/);
  });

  it("names each token's secret after the Plaid item, in characters Key Vault allows", () => {
    expect(accessTokenSecretName("eVBnVMp7zdTJLkRNr33Rs6zr7KNJqBFL9DrE6")).toBe("plaid-access-token-eVBnVMp7zdTJLkRNr33Rs6zr7KNJqBFL9DrE6");
    expect(accessTokenSecretName("item_sandbox.1")).toBe("plaid-access-token-item-sandbox-1");
  });
});
