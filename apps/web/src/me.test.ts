import { describe, expect, it, vi } from "vitest";
import { fetchMe } from "./me.js";

const api = "https://api.example.net";
const getToken = () => Promise.resolve("token-123");

describe("fetchMe", () => {
  it("sends the access token and returns who is signed in", async () => {
    const body = { name: "Test User", household: { id: "home" } };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    await expect(fetchMe(api, getToken, fetchFn)).resolves.toEqual({ state: "member", profile: body });
    expect(fetchFn).toHaveBeenCalledWith(`${api}/api/me`, { headers: { Authorization: "Bearer token-123" } });
  });

  it("reports an account outside the household when the API answers 403", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 403 }));

    await expect(fetchMe(api, getToken, fetchFn)).resolves.toEqual({ state: "not-a-member" });
  });

  it("asks to sign in again when the API answers 401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));

    await expect(fetchMe(api, getToken, fetchFn)).resolves.toEqual({ state: "signed-out" });
  });

  it("reports an error for anything else", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));

    await expect(fetchMe(api, getToken, fetchFn)).resolves.toEqual({ state: "error", reason: "HTTP 500" });
  });
});
