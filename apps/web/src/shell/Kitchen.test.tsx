// @vitest-environment jsdom
import type { PlannedMeal } from "@kitchen/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryMealPlanApi } from "../mealPlan/test-api.js";
import { inMemoryRecipeApi } from "../recipes/test-api.js";
import { inMemoryShoppingApi } from "../shopping/test-api.js";
import { Kitchen } from "./Kitchen.js";

vi.setConfig({ testTimeout: 20_000 });

const meal = (id: string, date: string, slot: PlannedMeal["slot"], recipeName: string): PlannedMeal => ({
  id,
  date,
  slot,
  recipeId: "11111111-1111-4111-8111-111111111111",
  recipeName,
  servings: 4,
});

beforeEach(() => {
  // A common phone width.
  window.innerWidth = 375;
  // The pantry screen calls the API itself.
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"products":[]}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const planned = () => [meal("a1", "2026-11-25", "dinner", "Lentil soup"), meal("a2", "2026-11-26", "lunch", "Flatbread")];

function open({ meals = planned(), mealPlan = inMemoryMealPlanApi(meals), today = "2026-11-25" as string | null } = {}) {
  const user = userEvent.setup();
  render(
    <Kitchen
      mealPlan={mealPlan}
      recipes={inMemoryRecipeApi()}
      shopping={inMemoryShoppingApi()}
      pantry={{ apiUrl: "https://api.example.net", getToken: async () => "token", onSignedOut: () => {} }}
      account={<p>Signed in as Test User</p>}
      today={today ?? undefined}
    />,
  );
  const nav = () => within(screen.getByRole("navigation", { name: "Main" }));
  const go = (name: string) => user.click(nav().getByRole("button", { name }));
  const current = () => nav().getByRole("button", { current: "page" }).textContent;
  const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
  return { user, mealPlan, nav, go, current, heading };
}

describe("the bottom navigation on a phone", () => {
  it("offers Today, Plan, Shopping, Pantry and Recipes, and opens on Today", async () => {
    const { nav, current, heading } = open();

    expect(nav().getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Plan", "Shopping", "Pantry", "Recipes"]);
    expect(current()).toBe("Today");
    await heading("Today");
  });

  it("switches screens, showing one at a time", async () => {
    const { go, current, heading } = open();

    for (const [tab, title] of [
      ["Plan", "Meal plan"],
      ["Shopping", "Shopping list"],
      ["Pantry", "Pantry"],
      ["Recipes", "Recipes"],
      ["Today", "Today"],
    ] as const) {
      await go(tab);
      await heading(title);
      expect(current()).toBe(tab);
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([title]);
    }
  });

  it("keeps your place in Recipes while you look at another screen", async () => {
    const { user, go, heading } = open();
    await go("Recipes");
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    await go("Shopping");
    await heading("Shopping list");
    await go("Recipes");

    await heading("Lentil soup");
  });
});

describe("Today", () => {
  it("shows today's planned meals only", async () => {
    open();

    const meals = await screen.findByRole("list", { name: "Today's meals" });

    expect(within(meals).getAllByRole("listitem").map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Dinner.*Lentil soup.*4 servings/),
    ]);
    expect(screen.getByText("Signed in as Test User")).toBeTruthy();
  });

  it("points to the plan when nothing is planned today", async () => {
    const { user, current } = open({ meals: [] });

    await user.click(await screen.findByRole("button", { name: "Plan a meal" }));

    expect(current()).toBe("Plan");
  });

  it("says so when the plan can't be loaded", async () => {
    const mealPlan = inMemoryMealPlanApi();
    mealPlan.week = () => Promise.reject(new Error("HTTP 500"));
    open({ mealPlan });

    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 500");
  });

  it("moves on to the new day when the app comes back after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 25, 23, 0));
    // No fixed date: the device's clock decides.
    open({ today: null });
    await screen.findByText("Lentil soup");

    vi.setSystemTime(new Date(2026, 10, 26, 7, 0));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(await screen.findByText("Flatbread")).toBeTruthy();
    expect(screen.queryByText("Lentil soup")).toBeNull();
    vi.useRealTimers();
  });
});
