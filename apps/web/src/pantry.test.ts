import type { PantryProduct } from "@kitchen/shared";
import { describe, expect, it, vi } from "vitest";
import { dollarsToCents, fetchPantry, formatPrice, formatQuantity, updateProduct } from "./pantry.js";

const api = "https://api.example.net";
const getToken = () => Promise.resolve("token-123");
const flour: PantryProduct = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  foodId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Flour",
  unit: "g",
  unitId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  stockQuantity: 500,
  staple: true,
  packageQuantity: 1500,
  priceCents: 249,
  priceDate: "2026-11-20",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fetchPantry", () => {
  it("sends the access token and returns the products", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ products: [flour] }));

    await expect(fetchPantry(api, getToken, fetchFn)).resolves.toEqual({ state: "ok", value: [flour] });
    expect(fetchFn).toHaveBeenCalledWith(`${api}/api/pantry/products`, { headers: { Authorization: "Bearer token-123" } });
  });

  it("asks to sign in again on 401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, 401));

    await expect(fetchPantry(api, getToken, fetchFn)).resolves.toEqual({ state: "signed-out" });
  });

  it("reports the server's reason when it gives one", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: "The pantry isn't available right now." }, 503));

    await expect(fetchPantry(api, getToken, fetchFn)).resolves.toEqual({
      state: "error",
      reason: "The pantry isn't available right now.",
    });
  });

  it("falls back to the status when the body is not the expected JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));

    await expect(fetchPantry(api, getToken, fetchFn)).resolves.toEqual({ state: "error", reason: "HTTP 502" });
  });

  it("reports a network failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchPantry(api, getToken, fetchFn)).resolves.toEqual({ state: "error", reason: "Failed to fetch" });
  });
});

describe("updateProduct", () => {
  it("patches the product and returns it as the server has it now", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ...flour, stockQuantity: 450 }));

    const result = await updateProduct(api, getToken, flour.id, { stock: { delta: -50 } }, fetchFn);

    expect(result).toEqual({ state: "ok", value: { ...flour, stockQuantity: 450 } });
    expect(fetchFn).toHaveBeenCalledWith(`${api}/api/pantry/products/${flour.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-123", "Content-Type": "application/json" },
      body: JSON.stringify({ stock: { delta: -50 } }),
    });
  });

  it("passes on why the server refused", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: "Stock can't go below 0." }, 400));

    await expect(updateProduct(api, getToken, flour.id, { stock: { delta: -9999 } }, fetchFn)).resolves.toEqual({
      state: "error",
      reason: "Stock can't go below 0.",
    });
  });
});

describe("formatting", () => {
  it.each([
    [249, "$2.49"],
    [5, "$0.05"],
    [0, "$0.00"],
    [123456, "$1,234.56"],
  ])("shows %i cents as %s", (cents, text) => {
    expect(formatPrice(cents)).toBe(text);
  });

  it.each([
    [500, "g", "500 g"],
    [1.5, "kg", "1.5 kg"],
    [0.3333, "cup", "0.3333 cup"],
    [12, "ea", "12 ea"],
  ])("shows %d %s as %s", (quantity, unit, text) => {
    expect(formatQuantity(quantity, unit)).toBe(text);
  });

  it.each([
    ["2.49", 249],
    ["$2.49", 249],
    [" 3 ", 300],
    ["0.1", 10],
    ["1,234.50", 123450],
    ["19.999", undefined],
    ["-1", undefined],
    ["abc", undefined],
    ["", undefined],
  ])("reads %j as %s cents", (text, cents) => {
    expect(dollarsToCents(text)).toBe(cents);
  });
});
