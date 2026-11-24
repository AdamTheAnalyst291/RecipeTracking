import { describe, expect, it, vi } from "vitest";
import { MealPlanApiError, createMealPlanApi } from "./api.js";

const meal = { id: "m1", date: "2026-11-24", slot: "dinner", recipeId: "r1", recipeName: "Lentil soup", servings: 4 };
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function api(response: Response) {
  const fetchFn = vi.fn(async () => response);
  return { fetchFn, api: createMealPlanApi("https://api.test", async () => "tok", fetchFn) };
}

describe("meal plan API client", () => {
  it("asks for a week with the bearer token", async () => {
    const { api: client, fetchFn } = api(json(200, { start: "2026-11-23", meals: [meal] }));

    expect(await client.week("2026-11-23")).toEqual([meal]);
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/api/meal-plan?start=2026-11-23", { method: "GET", headers: { Authorization: "Bearer tok" } });
  });

  it("adds, moves and removes", async () => {
    const add = api(json(201, meal));
    await add.api.add({ date: "2026-11-24", slot: "dinner", recipeId: "r1" });
    expect(add.fetchFn).toHaveBeenCalledWith(
      "https://api.test/api/meal-plan",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ date: "2026-11-24", slot: "dinner", recipeId: "r1" }) }),
    );

    const move = api(json(200, meal));
    await move.api.update("m1", { date: "2026-11-25" });
    expect(move.fetchFn).toHaveBeenCalledWith("https://api.test/api/meal-plan/m1", expect.objectContaining({ method: "PATCH" }));

    const remove = api(json(204));
    await remove.api.remove("m1");
    expect(remove.fetchFn).toHaveBeenCalledWith("https://api.test/api/meal-plan/m1", { method: "DELETE", headers: { Authorization: "Bearer tok" } });
  });

  it("carries the API's own explanation of a refusal", async () => {
    const { api: client } = api(json(400, { error: "Servings must be a whole number from 1 to 1000." }));

    await expect(client.update("m1", { servings: 0 })).rejects.toMatchObject({ status: 400, message: "Servings must be a whole number from 1 to 1000." });
  });

  it("falls back to the status, or the network's message", async () => {
    await expect(api(json(502)).api.week("2026-11-23")).rejects.toThrow("HTTP 502");
    const down = createMealPlanApi(
      "https://api.test",
      async () => "tok",
      async () => {
        throw new Error("offline");
      },
    );
    await expect(down.week("2026-11-23")).rejects.toBeInstanceOf(MealPlanApiError);
  });
});
