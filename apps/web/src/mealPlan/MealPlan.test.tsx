// @vitest-environment jsdom
import type { PlannedMeal } from "@kitchen/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inMemoryRecipeApi } from "../recipes/test-api.js";
import { MealPlanApiError } from "./api.js";
import { MealPlan } from "./MealPlan.js";
import { inMemoryMealPlanApi } from "./test-api.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 20_000 });

const SOUP = "11111111-1111-4111-8111-111111111111";
const BREAD = "22222222-2222-4222-8222-222222222222";

// Wednesday 25 Nov 2026; the week runs Monday 23rd to Sunday 29th.
const TODAY = "2026-11-25";
const meal = (id: string, date: string, slot: PlannedMeal["slot"], recipeId: string, recipeName: string, servings: number): PlannedMeal => ({
  id,
  date,
  slot,
  recipeId,
  recipeName,
  servings,
});
const week = () => [
  meal("a1", "2026-11-23", "lunch", BREAD, "Flatbread", 2),
  meal("a2", "2026-11-25", "dinner", SOUP, "Lentil soup", 4),
  meal("a3", "2026-11-25", "breakfast", BREAD, "Flatbread", 1),
];

function open(api = inMemoryMealPlanApi(week())) {
  const user = userEvent.setup();
  render(<MealPlan api={api} recipes={inMemoryRecipeApi()} today={TODAY} />);
  return { api, user };
}
const day = (label: string) => within(screen.getByRole("region", { name: label }));

describe("the week view", () => {
  it("shows today's meals first, then the rest of the week in order", async () => {
    open();

    await screen.findByRole("region", { name: "Wed 25 Nov" });
    const days = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(days).toEqual(["Wed 25 Nov", "Mon 23 Nov", "Tue 24 Nov", "Thu 26 Nov", "Fri 27 Nov", "Sat 28 Nov", "Sun 29 Nov"]);
    expect(within(screen.getAllByRole("region")[0] as HTMLElement).getByRole("heading").textContent).toContain("Today");
  });

  it("lists each day's meals from breakfast to snack with their servings", async () => {
    open();

    await screen.findByText("Lentil soup");
    const items = day("Wed 25 Nov").getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Breakfast.*Flatbread.*1 serving(?!s)/),
      expect.stringMatching(/^Dinner.*Lentil soup.*4 servings/),
    ]);
    expect(day("Tue 24 Nov").getByText("Nothing planned")).toBeTruthy();
  });

  it("says so when the week can't be loaded", async () => {
    const api = inMemoryMealPlanApi(week());
    api.failNextWith = new MealPlanApiError(503, "The meal plan isn't available right now.");
    open(api);

    expect((await screen.findByRole("alert")).textContent).toContain("isn't available");
  });

  it("moves between weeks, and back to this one", async () => {
    const api = inMemoryMealPlanApi([...week(), meal("b1", "2026-12-01", "dinner", SOUP, "Lentil soup", 3)]);
    const { user } = open(api);
    await screen.findByText("Lentil soup");

    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByRole("region", { name: "Tue 1 Dec" })).toBeTruthy();
    expect(within(screen.getAllByRole("region")[0] as HTMLElement).getByRole("heading").textContent).toBe("Mon 30 Nov");
    expect(day("Tue 1 Dec").getByText(/Lentil soup/)).toBeTruthy();
    expect(screen.queryByText("Today", { exact: false })).toBeNull();

    await user.click(screen.getByRole("button", { name: "This week" }));
    expect((await screen.findAllByRole("region"))[0]?.getAttribute("aria-label")).toBe("Wed 25 Nov");
  });
});

describe("planning meals", () => {
  it("adds a recipe to a day and meal, using its servings", async () => {
    const { api, user } = open();
    await screen.findByText("Lentil soup");

    await user.click(day("Fri 27 Nov").getByRole("button", { name: "Add meal on Fri 27 Nov" }));
    await user.selectOptions(day("Fri 27 Nov").getByLabelText("Meal"), "lunch");
    await user.selectOptions(day("Fri 27 Nov").getByLabelText("Recipe"), "Lentil soup");
    await user.click(day("Fri 27 Nov").getByRole("button", { name: "Add" }));

    const added = await day("Fri 27 Nov").findByText(/Lentil soup/);
    expect(added.closest("li")?.textContent).toMatch(/^Lunch.*4 servings/);
    expect([...api.meals.values()].filter((m) => m.date === "2026-11-27")).toEqual([
      expect.objectContaining({ slot: "lunch", recipeId: SOUP, servings: 4 }),
    ]);
  });

  it("can set the servings while adding", async () => {
    const { api, user } = open();
    await screen.findByText("Lentil soup");

    await user.click(day("Thu 26 Nov").getByRole("button", { name: "Add meal on Thu 26 Nov" }));
    await user.selectOptions(day("Thu 26 Nov").getByLabelText("Recipe"), "Flatbread");
    await user.type(day("Thu 26 Nov").getByLabelText("Servings"), "6");
    await user.click(day("Thu 26 Nov").getByRole("button", { name: "Add" }));

    await day("Thu 26 Nov").findByText(/6 servings/);
    expect([...api.meals.values()].find((m) => m.date === "2026-11-26")).toMatchObject({ slot: "dinner", servings: 6 });
  });

  it("moves a meal to another day and meal", async () => {
    const { api, user } = open();
    await screen.findByText("Lentil soup");

    await user.click(day("Wed 25 Nov").getByRole("button", { name: "Move Lentil soup" }));
    await user.selectOptions(day("Wed 25 Nov").getByLabelText("Day"), "Sat 28 Nov");
    await user.selectOptions(day("Wed 25 Nov").getByLabelText("Meal"), "lunch");
    await user.click(day("Wed 25 Nov").getByRole("button", { name: "Move" }));

    await day("Sat 28 Nov").findByText(/Lentil soup/);
    expect(day("Wed 25 Nov").queryByText(/Lentil soup/)).toBeNull();
    expect(api.meals.get("a2")).toMatchObject({ date: "2026-11-28", slot: "lunch", servings: 4 });
  });

  it("changes servings a step at a time, never below 1", async () => {
    const { api, user } = open();
    await screen.findByText("Lentil soup");

    await user.click(day("Wed 25 Nov").getByRole("button", { name: "More servings of Lentil soup" }));
    await day("Wed 25 Nov").findByText(/5 servings/);
    await user.click(day("Wed 25 Nov").getByRole("button", { name: "Fewer servings of Lentil soup" }));
    await day("Wed 25 Nov").findByText(/4 servings/);
    expect(api.meals.get("a2")?.servings).toBe(4);

    const single = day("Wed 25 Nov").getByRole("button", { name: "Fewer servings of Flatbread" });
    expect((single as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes a meal", async () => {
    const { api, user } = open();
    await screen.findByText("Lentil soup");

    await user.click(day("Wed 25 Nov").getByRole("button", { name: "Remove Lentil soup" }));

    await day("Wed 25 Nov").findByText(/Flatbread/);
    expect(day("Wed 25 Nov").queryByText(/Lentil soup/)).toBeNull();
    expect(api.meals.has("a2")).toBe(false);
    expect(api.meals.size).toBe(2);
  });

  it("shows why a change failed and leaves the plan as it was", async () => {
    const api = inMemoryMealPlanApi(week());
    const { user } = open(api);
    await screen.findByText("Lentil soup");
    api.remove = async () => {
      throw new MealPlanApiError(404, "No such planned meal.");
    };

    await user.click(day("Wed 25 Nov").getByRole("button", { name: "Remove Lentil soup" }));

    expect((await screen.findByRole("alert")).textContent).toContain("No such planned meal.");
    expect(day("Wed 25 Nov").getByText(/Lentil soup/)).toBeTruthy();
  });
});
