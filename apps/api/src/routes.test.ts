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

  it("is public only if it is the health check", () => {
    expect(routes.filter((r) => r.access === "public").map((r) => r.name)).toEqual(["health"]);
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
