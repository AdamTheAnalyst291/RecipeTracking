import {
  BrowserAuthError,
  BrowserAuthErrorCodes,
  createStandardPublicClientApplication,
  InteractionRequiredAuthError,
  ServerError,
  type AccountInfo,
} from "@azure/msal-browser";
import type { AuthSettings } from "./health.js";

export interface SignIn {
  /** The signed-in Microsoft account, or null before sign-in. */
  account: AccountInfo | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** An access token for the kitchen API. Redirects to Microsoft when it needs the user again. */
  getToken(): Promise<string>;
}

/** The delegated scope the kitchen's app registration exposes (infra/README.md, "Sign-in"). */
export function apiScope(clientId: string): string {
  return `api://${clientId}/access_as_user`;
}

/**
 * Whether a failed silent renewal needs a trip to Microsoft: MSAL says the user must sign in
 * again, Entra turned the renewal down, or the hidden iframe's answer never came back through
 * the redirect bridge. Anything else (offline, a network error) is left to the caller, so a
 * phone without signal isn't sent off to a sign-in page it can't load.
 */
function needsInteractiveSignIn(error: unknown): boolean {
  if (error instanceof InteractionRequiredAuthError || error instanceof ServerError) return true;
  return error instanceof BrowserAuthError && error.errorCode === BrowserAuthErrorCodes.timedOut;
}

/**
 * Microsoft Entra sign-in with MSAL (auth code flow with PKCE, redirects only). Static Web Apps'
 * built-in sign-in can't be used: on the Free plan the API is a separate Functions app, which
 * never sees Static Web Apps' sign-in, so the API checks an Entra access token instead.
 */
export async function startSignIn(auth: AuthSettings): Promise<SignIn> {
  const msal = await createStandardPublicClientApplication({
    auth: {
      clientId: auth.clientId,
      authority: `https://login.microsoftonline.com/${auth.tenantId}`,
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
    },
    // Kept across visits so the installed app doesn't ask for sign-in every time it opens.
    cache: { cacheLocation: "localStorage" },
  });

  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getAllAccounts()[0] ?? null;
  if (account) msal.setActiveAccount(account);
  const scopes = [apiScope(auth.clientId)];
  // When the refresh token has expired, MSAL renews in a hidden iframe, and MSAL v5 only hears
  // the answer through a page that runs its redirect bridge (redirect.html). Full-page sign-in
  // keeps "/" as its redirect URI.
  const bridgeUri = `${window.location.origin}/redirect.html`;

  return {
    account,
    signIn: () => msal.loginRedirect({ scopes }),
    signOut: () => msal.logoutRedirect(account ? { account } : undefined),
    getToken: async () => {
      if (!account) throw new Error("Not signed in");
      try {
        return (await msal.acquireTokenSilent({ scopes, account, redirectUri: bridgeUri })).accessToken;
      } catch (error) {
        if (needsInteractiveSignIn(error)) await msal.acquireTokenRedirect({ scopes, account });
        throw error;
      }
    },
  };
}
