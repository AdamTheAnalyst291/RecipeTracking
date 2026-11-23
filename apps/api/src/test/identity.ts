/**
 * Test identities: a local signing key standing in for Microsoft Entra, and tokens signed with
 * it. Nothing here is a real tenant, app or account; every ID is made up.
 */
import { HttpRequest } from "@azure/functions";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createAuthenticator, type AuthConfig } from "../auth.js";

export const TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
export const ADAM = "33333333-3333-4333-8333-333333333333";
export const SOMEONE_ELSE = "44444444-4444-4444-8444-444444444444";

export const testConfig: AuthConfig = {
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  household: { id: "home", memberObjectIds: [ADAM] },
};

const entra = await generateKeyPair("RS256");
const impostor = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(entra.publicKey)), kid: "entra-test-key", alg: "RS256" };

/** An authenticator that trusts the test key, as the real one trusts Entra's published keys. */
export const testAuthenticator = createAuthenticator(testConfig, createLocalJWKSet({ keys: [jwk] }));

/** A token as Entra would issue it to the web app for Adam, with any claim overridden. */
export async function token(
  claims: JWTPayload & { oid?: string; scp?: string; name?: string } = {},
  options: { expiresIn?: string; signedBy?: "entra" | "impostor" } = {},
): Promise<string> {
  const key = options.signedBy === "impostor" ? impostor.privateKey : entra.privateKey;
  return new SignJWT({
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    aud: CLIENT_ID,
    oid: ADAM,
    tid: TENANT_ID,
    scp: "access_as_user",
    name: "Test User",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "entra-test-key" })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(key);
}

export function request(authorization?: string): HttpRequest {
  return new HttpRequest({
    method: "GET",
    url: "http://localhost:7071/api/me",
    headers: authorization === undefined ? {} : { authorization },
  });
}
