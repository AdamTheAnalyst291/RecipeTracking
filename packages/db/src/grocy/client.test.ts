import { describe, expect, it } from "vitest";
import { GrocyHttpError, createGrocyClient, readGrocy } from "./client.js";
import { fakeGrocy, loadGrocyFixture } from "./fake-grocy.js";

const base = { baseUrl: "http://grocy.test:9283", apiKey: "secret-key" };

describe("the Grocy client", () => {
  it("sends only GET requests, with the key and no body, for a whole read", async () => {
    const { fetch, requests } = fakeGrocy();
    await readGrocy(createGrocyClient({ ...base, fetch }));
    expect(requests.length).toBeGreaterThan(5);
    expect(new Set(requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(requests.every((r) => r.headers["GROCY-API-KEY"] === "secret-key")).toBe(true);
    expect(requests.every((r) => r.body === undefined)).toBe(true);
  });

  it("offers no way to send anything but a GET", () => {
    const client = createGrocyClient({ ...base, fetch: fakeGrocy().fetch });
    expect(Object.keys(client)).toEqual(["get"]);
  });

  it("refuses a path that would leave the Grocy server, before sending anything", async () => {
    const { fetch, requests } = fakeGrocy();
    const client = createGrocyClient({ ...base, fetch });
    await expect(client.get("//evil.test/api/stock")).rejects.toThrow(/leaves the Grocy server/);
    await expect(client.get("api/stock")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("never follows a redirect, so the key can't be sent to another host", async () => {
    const { fetch, requests } = fakeGrocy();
    await readGrocy(createGrocyClient({ ...base, fetch }));
    expect(requests.every((r) => r.redirect === "error")).toBe(true);
  });

  it("keeps a sub-path in the Grocy URL", async () => {
    const { fetch, requests } = fakeGrocy();
    await createGrocyClient({ baseUrl: "http://grocy.test/grocy/", apiKey: "k", fetch }).get("/api/stock").catch(() => undefined);
    expect(requests[0]?.url).toBe("http://grocy.test/grocy/api/stock");
  });

  it("refuses a URL that isn't http(s)", () => {
    expect(() => createGrocyClient({ baseUrl: "file:///etc/passwd", apiKey: "k" })).toThrow();
  });

  it("throws a typed error for a refused request", async () => {
    const client = createGrocyClient({ ...base, fetch: (async () => new Response("no", { status: 401 })) as typeof fetch });
    await expect(client.get("/api/stock")).rejects.toBeInstanceOf(GrocyHttpError);
  });

  it("reads every product, stock row and unit, and reports details it can't read", async () => {
    const fixture = loadGrocyFixture();
    delete fixture.details["3"];
    const data = await readGrocy(createGrocyClient({ ...base, fetch: fakeGrocy({ fixture }).fetch }));
    expect(data.products).toHaveLength(6);
    expect(data.stock).toHaveLength(4);
    expect(data.units).toHaveLength(5);
    expect(Object.keys(data.details).sort()).toEqual(["1", "2", "4", "5", "6"]);
    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]).toMatch(/Canned Tomatoes/);
  });
});
