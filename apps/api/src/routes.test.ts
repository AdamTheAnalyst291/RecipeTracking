import { HttpRequest, InvocationContext } from "@azure/functions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routes } from "./routes.js";
import { ADAM, CLIENT_ID, TENANT_ID } from "./test/identity.js";

describe("every API function", () => {
  beforeAll(() => {
    vi.stubEnv("KITCHEN_AUTH_TENANT_ID", TENANT_ID);
    vi.stubEnv("KITCHEN_AUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("KITCHEN_HOUSEHOLD_MEMBERS", ADAM);
  });
  afterAll(() => vi.unstubAllEnvs());

  it("is public only if it is the health check or the MCP sign-in metadata", () => {
    expect(routes.filter((r) => r.access === "public").map((r) => r.name)).toEqual(["health", "mcpMetadata"]);
  });

  it("answers 401 on the MCP endpoint with a challenge naming its resource metadata", async () => {
    const mcp = routes.find((r) => r.name === "mcp")!;
    const request = new HttpRequest({ method: "POST", url: "https://func-kitchen-dev.azurewebsites.net/api/mcp" });

    const response = await mcp.handler(request, new InvocationContext());

    expect(response.status).toBe(401);
    expect((response.headers as Record<string, string>)["WWW-Authenticate"]).toContain(
      'resource_metadata="https://func-kitchen-dev.azurewebsites.net/api/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it.each(routes.filter((r) => r.access === "household").map((r) => [r.name, r] as const))(
    "%s answers 401 without a token",
    async (_name, route) => {
      for (const method of route.methods) {
        const request = new HttpRequest({ method, url: `http://localhost:7071/api/${route.route}` });
        const response = await route.handler(request, new InvocationContext());

        expect(response.status).toBe(401);
      }
    },
  );
});
