import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** A group of people who share one kitchen. There is one household for now, with Adam in it. */
export interface Household {
  id: string;
  /** Microsoft Entra object IDs (`oid`) of the people allowed in. */
  memberObjectIds: string[];
}

export interface AuthConfig {
  /** The Entra tenant that signs tokens. */
  tenantId: string;
  /** The kitchen's Entra app registration; tokens must be issued for it. */
  clientId: string;
  household: Household;
}

/** Someone who signed in and belongs to the household. */
export interface SignedInUser {
  objectId: string;
  name: string | undefined;
  household: Household;
}

export type AuthResult = { ok: true; user: SignedInUser } | { ok: false; response: HttpResponseInit };

export type Authenticator = (request: HttpRequest) => Promise<AuthResult>;

/** The delegated scope the app registration exposes, `api://<client id>/access_as_user`. */
export const API_SCOPE = "access_as_user";

const unauthenticated: HttpResponseInit = {
  status: 401,
  headers: { "WWW-Authenticate": "Bearer" },
  jsonBody: { error: "Sign in first." },
};

const unavailable: HttpResponseInit = {
  status: 503,
  jsonBody: { error: "Sign-in can't be checked right now. Try again shortly." },
};

const forbidden: HttpResponseInit = {
  status: 403,
  jsonBody: { error: "This account isn't a member of the household." },
};

export function createAuthenticator(config: AuthConfig, keys: JWTVerifyGetKey): Authenticator {
  return async (request) => {
    const header = request.headers.get("authorization");
    const match = header === null ? null : /^Bearer ([^\s]+)$/i.exec(header);
    if (!match?.[1]) return { ok: false, response: unauthenticated };

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[1], keys, {
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        audience: config.clientId,
        algorithms: ["RS256"],
      }));
    } catch (error) {
      // A token that fails a check is the caller's problem (401). Not reaching Entra's
      // published keys is ours: say so, rather than sending the user round a sign-in loop.
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
        return { ok: false, response: unauthenticated };
      }
      console.error("Could not check the token against Entra's signing keys", error);
      return { ok: false, response: unavailable };
    }

    // A token the web app got for a person carries the delegated scope; an app-only token
    // (a service principal signing in as itself) has roles instead and is never let in.
    const scopes = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
    const objectId = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
    if (!scopes.includes(API_SCOPE) || !config.household.memberObjectIds.includes(objectId)) {
      return { ok: false, response: forbidden };
    }
    return {
      ok: true,
      user: { objectId, name: typeof payload.name === "string" ? payload.name : undefined, household: config.household },
    };
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The only household for now. Its members come from configuration until the database holds them. */
const HOUSEHOLD_ID = "home";

/**
 * Reads the auth settings Terraform puts on the Functions app:
 * - `KITCHEN_AUTH_TENANT_ID`, `KITCHEN_AUTH_CLIENT_ID`: the tenant and the app registration.
 * - `KITCHEN_HOUSEHOLD_MEMBERS`: comma-separated Entra object IDs, from Key Vault.
 * Returns the problem instead when a setting is missing or not an ID.
 */
function readAuthConfig(env: Record<string, string | undefined>): AuthConfig | string {
  const tenantId = env.KITCHEN_AUTH_TENANT_ID?.trim().toLowerCase() ?? "";
  const clientId = env.KITCHEN_AUTH_CLIENT_ID?.trim().toLowerCase() ?? "";
  const members = (env.KITCHEN_HOUSEHOLD_MEMBERS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== "");
  if (!GUID.test(tenantId)) return "KITCHEN_AUTH_TENANT_ID is not set to a tenant ID";
  if (!GUID.test(clientId)) return "KITCHEN_AUTH_CLIENT_ID is not set to an app registration's client ID";
  if (members.length === 0 || !members.every((id) => GUID.test(id))) {
    return "KITCHEN_HOUSEHOLD_MEMBERS is not a list of object IDs (is the household-members secret in Key Vault?)";
  }
  return { tenantId, clientId, household: { id: HOUSEHOLD_ID, memberObjectIds: members } };
}

/**
 * The authenticator for the deployed API: it trusts the keys Entra publishes for the tenant.
 * Without valid settings it refuses every request with 500, so a setup mistake never lets anyone in.
 */
export function authenticatorFromEnv(
  env: Record<string, string | undefined>,
  keys?: JWTVerifyGetKey,
): Authenticator & { config?: AuthConfig } {
  const config = readAuthConfig(env);
  if (typeof config === "string") {
    console.error(`Sign-in is not configured: ${config}`);
    return async () => ({
      ok: false,
      response: { status: 500, jsonBody: { error: "Sign-in isn't set up on the server." } },
    });
  }
  const entraKeys =
    keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
  return Object.assign(createAuthenticator(config, entraKeys), { config });
}

let fromProcessEnv: Authenticator | undefined;

/** Built on first use, so the app settings are read at request time and Entra's keys are cached. */
export function defaultAuthenticator(): Authenticator {
  fromProcessEnv ??= authenticatorFromEnv(process.env);
  return fromProcessEnv;
}

export type AuthenticatedHandler = (
  request: HttpRequest,
  context: InvocationContext,
  user: SignedInUser,
) => Promise<HttpResponseInit>;

/** The `WWW-Authenticate` value a route sends with a 401, when plain `Bearer` isn't enough. */
export type Challenge = (request: HttpRequest) => string;

/**
 * Wraps a handler so it runs only for a signed-in household member. A `challenge` replaces
 * the 401's `WWW-Authenticate` header; the MCP endpoint uses it to tell clients where to sign in.
 */
export function withAuth(
  handler: AuthenticatedHandler,
  getAuthenticator: () => Authenticator = defaultAuthenticator,
  challenge?: Challenge,
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  return async (request, context) => {
    const result = await getAuthenticator()(request);
    if (!result.ok) {
      if (challenge === undefined || result.response.status !== 401) return result.response;
      return { ...result.response, headers: { "WWW-Authenticate": challenge(request) } };
    }
    return handler(request, context, result.user);
  };
}
