import { describe, expect, it } from "vitest";
import { MealieHttpError, createMealieClient, readMealie } from "./client.js";
import { fakeMealie } from "./fake-mealie.js";

describe("the Mealie client", () => {
  it("sends only GET requests, with the token and no body, for a whole read", async () => {
    const { fetch, requests } = fakeMealie();
    await readMealie(createMealieClient({ baseUrl: "http://mealie.test:9925", token: "secret-token", fetch }));
    expect(requests.length).toBeGreaterThan(5);
    expect(new Set(requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(requests.every((r) => r.headers.Authorization === "Bearer secret-token")).toBe(true);
    expect(requests.every((r) => r.body === undefined)).toBe(true);
  });

  it("offers no way to send anything but a GET", () => {
    const client = createMealieClient({ baseUrl: "http://mealie.test", token: "t", fetch: fakeMealie().fetch });
    expect(Object.keys(client)).toEqual(["get"]);
  });

  it("reads every food, readable recipe and meal plan entry, and reports a recipe it can't read", async () => {
    const { fetch } = fakeMealie();
    const data = await readMealie(createMealieClient({ baseUrl: "http://mealie.test", token: "t", fetch }));
    expect(data.foods).toHaveLength(4);
    expect(data.recipes).toHaveLength(3);
    expect(data.mealPlans).toHaveLength(5);
    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]).toMatch(/Recipe "broken-recipe"/);
  });

  it("falls back to the older meal plan path", async () => {
    const { fetch, requests } = fakeMealie({ oldMealPlanPath: true });
    const data = await readMealie(createMealieClient({ baseUrl: "http://mealie.test", token: "t", fetch }));
    expect(data.mealPlans).toHaveLength(5);
    expect(requests.some((r) => r.url.includes("/api/groups/mealplans"))).toBe(true);
  });

  it("throws a typed error for a refused request", async () => {
    const client = createMealieClient({
      baseUrl: "http://mealie.test",
      token: "t",
      fetch: (async () => new Response("no", { status: 401 })) as typeof fetch,
    });
    await expect(client.get("/api/foods")).rejects.toBeInstanceOf(MealieHttpError);
  });

  it("refuses a URL that isn't http(s)", () => {
    expect(() => createMealieClient({ baseUrl: "file:///etc/passwd", token: "t" })).toThrow();
  });
});
