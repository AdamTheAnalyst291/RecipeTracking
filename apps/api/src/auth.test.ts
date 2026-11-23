import { describe, expect, it } from "vitest";
import { authenticatorFromEnv } from "./auth.js";
import { ADAM, CLIENT_ID, request, TENANT_ID, token } from "./test/identity.js";

const goodEnv = {
  KITCHEN_AUTH_TENANT_ID: TENANT_ID,
  KITCHEN_AUTH_CLIENT_ID: CLIENT_ID,
  KITCHEN_HOUSEHOLD_MEMBERS: ADAM,
};

describe("authenticatorFromEnv", () => {
  it("builds the household from the app settings", async () => {
    const authenticate = authenticatorFromEnv({ ...goodEnv, KITCHEN_HOUSEHOLD_MEMBERS: ` ${ADAM.toUpperCase()} , ` });

    expect(authenticate.config).toEqual({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      household: { id: "home", memberObjectIds: [ADAM] },
    });
  });

  it.each([
    ["the tenant is missing", { ...goodEnv, KITCHEN_AUTH_TENANT_ID: undefined }],
    ["the client ID is empty", { ...goodEnv, KITCHEN_AUTH_CLIENT_ID: "" }],
    ["the household has no members", { ...goodEnv, KITCHEN_HOUSEHOLD_MEMBERS: "" }],
    [
      "the Key Vault reference didn't resolve",
      { ...goodEnv, KITCHEN_HOUSEHOLD_MEMBERS: "@Microsoft.KeyVault(VaultName=kv;SecretName=household-members)" },
    ],
  ])("refuses every request with 500 when %s", async (_name, env) => {
    const authenticate = authenticatorFromEnv(env);

    const result = await authenticate(request(`Bearer ${await token()}`));

    expect(authenticate.config).toBeUndefined();
    expect(result).toMatchObject({ ok: false, response: { status: 500 } });
  });
});
