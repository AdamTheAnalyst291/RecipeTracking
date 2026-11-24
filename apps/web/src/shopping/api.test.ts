import { describe, expect, it, vi } from "vitest";
import { ShoppingApiError, createShoppingApi } from "./api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(response: Response) {
  const fetchFn = vi.fn(async () => response.clone());
  return { fetchFn, api: createShoppingApi("https://api.test", async () => "tok", fetchFn) };
}
const call = (fetchFn: ReturnType<typeof vi.fn>) => fetchFn.mock.calls[0] as unknown as [string, RequestInit];

describe("the shopping API client", () => {
  it("asks for the latest list with the bearer token, and maps no list to null", async () => {
    const { api, fetchFn } = setup(json({ list: null }));
    expect(await api.latest()).toBeNull();
    const [url, init] = call(fetchFn);
    expect(url).toBe("https://api.test/api/shopping-list");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("posts the dates to build a list", async () => {
    const { api, fetchFn } = setup(json({ id: "l" }));
    await api.generate({ start: "2026-11-23", end: "2026-11-29" });
    const [url, init] = call(fetchFn);
    expect([url, init.method, init.body]).toEqual(["https://api.test/api/shopping-list", "POST", '{"start":"2026-11-23","end":"2026-11-29"}']);
  });

  it("checks an item off with PATCH and removes with DELETE", async () => {
    const patch = setup(json({ id: "i" }));
    await patch.api.setChecked("l1", "i1", true);
    expect(call(patch.fetchFn)[0]).toBe("https://api.test/api/shopping-list/l1/items/i1");
    expect(call(patch.fetchFn)[1].body).toBe('{"checked":true}');

    const del = setup(new Response(null, { status: 204 }));
    await del.api.removeItem("l1", "i1");
    expect(call(del.fetchFn)[1].method).toBe("DELETE");
  });

  it("turns a refusal into an error carrying the API's message", async () => {
    const { api } = setup(json({ error: "nope" }, 400));
    await expect(api.addItem("l1", { name: "x" })).rejects.toMatchObject({ status: 400, message: "nope" });
    await expect(api.addItem("l1", { name: "x" })).rejects.toBeInstanceOf(ShoppingApiError);
  });

  it("turns a network failure into an error", async () => {
    const api = createShoppingApi("https://api.test", async () => "t", async () => Promise.reject(new Error("offline")));
    await expect(api.latest()).rejects.toMatchObject({ status: 0, message: "offline" });
  });
});
