import { InvocationContext } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { withAuth } from "../auth.js";
import { request, SOMEONE_ELSE, testAuthenticator, token } from "../test/identity.js";
import { meHandler } from "./me.js";

const me = withAuth(meHandler, () => testAuthenticator);

describe("GET /api/me", () => {
  it("rejects a request with no token with 401", async () => {
    const response = await me(request(), new InvocationContext());

    expect(response.status).toBe(401);
    expect(response.headers).toMatchObject({ "WWW-Authenticate": "Bearer" });
  });

  it("accepts Adam's token with 200 and names his household", async () => {
    const response = await me(request(`Bearer ${await token()}`), new InvocationContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ name: "Test User", household: { id: "home" } });
  });

  it("refuses a different signed-in account with 403", async () => {
    const response = await me(request(`Bearer ${await token({ oid: SOMEONE_ELSE })}`), new InvocationContext());

    expect(response.status).toBe(403);
  });

  it.each([
    ["not a bearer token", async () => "Basic dXNlcjpwYXNz"],
    ["a malformed token", async () => "Bearer not-a-jwt"],
    ["a token signed by someone other than Entra", async () => `Bearer ${await token({}, { signedBy: "impostor" })}`],
    ["an expired token", async () => `Bearer ${await token({}, { expiresIn: "-1m" })}`],
    ["a token for another app", async () => `Bearer ${await token({ aud: "55555555-5555-4555-8555-555555555555" })}`],
    ["a token from another tenant", async () => `Bearer ${await token({ iss: "https://login.microsoftonline.com/66666666-6666-4666-8666-666666666666/v2.0" })}`],
  ])("rejects %s with 401", async (_name, authorization) => {
    const response = await me(request(await authorization()), new InvocationContext());

    expect(response.status).toBe(401);
  });

  it("refuses an app-only token for Adam's object ID with 403, since it wasn't issued to a person", async () => {
    const response = await me(request(`Bearer ${await token({ scp: undefined, roles: ["Something.Read"] })}`), new InvocationContext());

    expect(response.status).toBe(403);
  });
});
