// @vitest-environment jsdom
import {
  BrowserAuthError,
  BrowserAuthErrorCodes,
  InteractionRequiredAuthError,
  ServerError,
  type AccountInfo,
} from "@azure/msal-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSignIn } from "./signIn.js";

const account = { homeAccountId: "adam", username: "adam@example.com" } as AccountInfo;
const auth = { clientId: "client-1", tenantId: "tenant-1" };
const scopes = ["api://client-1/access_as_user"];

// A stand-in for MSAL's PublicClientApplication: the app only talks to MSAL through these calls.
const msal = {
  handleRedirectPromise: vi.fn(),
  getAllAccounts: vi.fn(),
  setActiveAccount: vi.fn(),
  acquireTokenSilent: vi.fn(),
  acquireTokenRedirect: vi.fn(),
  loginRedirect: vi.fn(),
  logoutRedirect: vi.fn(),
};

vi.mock("@azure/msal-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/msal-browser")>()),
  createStandardPublicClientApplication: vi.fn(() => Promise.resolve(msal)),
}));

beforeEach(() => {
  for (const fn of Object.values(msal)) fn.mockReset();
  msal.handleRedirectPromise.mockResolvedValue(null);
  msal.getAllAccounts.mockReturnValue([account]);
  msal.acquireTokenRedirect.mockResolvedValue(undefined);
});

/** What MSAL 5.30.0 throws when the hidden iframe's answer never comes back through the redirect bridge. */
const bridgeTimeout = () => new BrowserAuthError(BrowserAuthErrorCodes.timedOut, "", "redirect_bridge_timeout");

describe("getToken", () => {
  it("returns the access token MSAL renews silently", async () => {
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: "token-123" });

    const signIn = await startSignIn(auth);

    await expect(signIn.getToken()).resolves.toBe("token-123");
    expect(msal.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("sends an expired refresh token's renewal through the redirect bridge page", async () => {
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: "token-123" });

    const signIn = await startSignIn(auth);
    await signIn.getToken();

    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({
      scopes,
      account,
      redirectUri: `${window.location.origin}/redirect.html`,
    });
  });

  it("leaves a network failure to the caller instead of leaving the app", async () => {
    msal.acquireTokenSilent.mockRejectedValue(new BrowserAuthError(BrowserAuthErrorCodes.noNetworkConnectivity, ""));

    const signIn = await startSignIn(auth);

    await expect(signIn.getToken()).rejects.toThrow();
    expect(msal.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("goes to Microsoft for a new sign-in when the silent renewal times out", async () => {
    msal.acquireTokenSilent.mockRejectedValue(bridgeTimeout());

    const signIn = await startSignIn(auth);

    await expect(signIn.getToken()).rejects.toThrow();
    expect(msal.acquireTokenRedirect).toHaveBeenCalledWith({ scopes, account });
  });

  it("goes to Microsoft when Entra turns the silent renewal down", async () => {
    msal.acquireTokenSilent.mockRejectedValue(new ServerError("invalid_request", "AADSTS50011: redirect URI mismatch"));

    const signIn = await startSignIn(auth);

    await expect(signIn.getToken()).rejects.toThrow();
    expect(msal.acquireTokenRedirect).toHaveBeenCalledWith({ scopes, account });
  });

  it("goes to Microsoft when MSAL says the user must sign in again", async () => {
    msal.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("login_required", ""));

    const signIn = await startSignIn(auth);

    await expect(signIn.getToken()).rejects.toThrow();
    expect(msal.acquireTokenRedirect).toHaveBeenCalledWith({ scopes, account });
  });
});
