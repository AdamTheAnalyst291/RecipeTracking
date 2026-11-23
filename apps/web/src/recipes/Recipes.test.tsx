// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipeApiError } from "./api.js";
import { Recipes } from "./Recipes.js";
import { flatbread, inMemoryRecipeApi, lentilSoup } from "./test-api.js";

afterEach(cleanup);

// Typing a whole form is slow on a busy CI runner.
vi.setConfig({ testTimeout: 20_000 });

function open(api = inMemoryRecipeApi()) {
  const user = userEvent.setup();
  render(<Recipes api={api} />);
  return { api, user };
}

describe("browsing recipes", () => {
  it("lists recipes by name with their time and tags", async () => {
    open();

    const list = await screen.findByRole("list", { name: "Recipes" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => within(i).getByRole("button").textContent)).toEqual(["Flatbread", "Lentil soup"]);
    const soup = items[1]?.textContent ?? "";
    expect(soup).toContain("45 min");
    expect(soup).toContain("4 servings");
    expect(soup).toContain("quick, soup");
  });

  it("narrows the list by name or tag", async () => {
    const { user } = open();
    await screen.findByText("Flatbread");

    await user.type(screen.getByRole("searchbox", { name: "Search recipes" }), "sou");
    expect(screen.queryByText("Flatbread")).toBeNull();
    expect(screen.getByText("Lentil soup")).toBeTruthy();

    await user.clear(screen.getByRole("searchbox", { name: "Search recipes" }));
    await user.type(screen.getByRole("searchbox", { name: "Search recipes" }), "bread");
    expect(screen.getByText("Flatbread")).toBeTruthy();
    expect(screen.queryByText("Lentil soup")).toBeNull();
  });

  it("invites the first recipe when there are none", async () => {
    open(inMemoryRecipeApi([]));

    expect(await screen.findByText(/No recipes yet/)).toBeTruthy();
  });

  it("says so when the list can't be loaded", async () => {
    const api = inMemoryRecipeApi();
    api.failNextWith = new RecipeApiError(500, ["HTTP 500"]);
    open(api);

    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 500");
  });
});

describe("viewing a recipe", () => {
  it("shows its ingredients, steps and where it came from", async () => {
    const { user } = open();

    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    expect(await screen.findByRole("heading", { name: "Lentil soup" })).toBeTruthy();
    const ingredients = within(screen.getByRole("list", { name: "Ingredients" })).getAllByRole("listitem");
    expect(ingredients.map((i) => i.textContent)).toEqual(["1.5 cup Red lentils, rinsed", "Salt"]);
    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Simmer the lentils.", "Season and serve."]);
    expect(screen.getByRole("link", { name: /Made-up Cookbook/ })).toHaveProperty("href", "https://example.com/lentil-soup");
  });

  it("goes back to the list", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: "Flatbread" }));

    await user.click(await screen.findByRole("button", { name: "Back to recipes" }));

    expect(await screen.findByRole("list", { name: "Recipes" })).toBeTruthy();
  });
});

describe("adding a recipe", () => {
  it("saves a new recipe with ingredients and steps and then shows it", async () => {
    const { api, user } = open(inMemoryRecipeApi([]));
    await user.click(await screen.findByRole("button", { name: "Add recipe" }));

    await user.type(screen.getByLabelText("Name"), "Garlic noodles");
    await user.type(screen.getByLabelText("Servings"), "2");
    await user.type(screen.getByLabelText("Total time (minutes)"), "15");
    await user.type(screen.getByLabelText("Source link"), "https://example.com/noodles");
    await user.type(screen.getByLabelText("Credit"), "Someone Made-up");
    await user.type(screen.getByLabelText("Tags"), "quick, Noodles");
    await user.click(screen.getByRole("button", { name: "Add ingredient" }));
    await user.type(screen.getByLabelText("Food 1"), "Noodles");
    await user.type(screen.getByLabelText("Quantity 1"), "200");
    await user.selectOptions(screen.getByLabelText("Unit 1"), "g");
    await user.type(screen.getByLabelText("Note 1"), "dried");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    await user.type(screen.getByLabelText("Step 1"), "Boil the noodles.");
    await user.click(screen.getByRole("button", { name: "Save recipe" }));

    expect(await screen.findByRole("heading", { name: "Garlic noodles" })).toBeTruthy();
    expect([...api.recipes.values()]).toEqual([
      {
        id: expect.any(String),
        name: "Garlic noodles",
        servings: 2,
        totalMinutes: 15,
        sourceUrl: "https://example.com/noodles",
        sourceCredit: "Someone Made-up",
        tags: ["quick", "Noodles"],
        ingredients: [{ food: "Noodles", quantity: 200, unit: "g", note: "dried" }],
        steps: ["Boil the noodles."],
      },
    ]);
  });

  it("says what is wrong instead of saving an incomplete recipe", async () => {
    const { api, user } = open(inMemoryRecipeApi([]));
    await user.click(await screen.findByRole("button", { name: "Add recipe" }));

    await user.click(screen.getByRole("button", { name: "Save recipe" }));

    expect(screen.getByRole("alert").textContent).toContain("Name is required.");
    expect(api.recipes.size).toBe(0);
  });

  it("shows the API's complaint and keeps what was typed", async () => {
    const api = inMemoryRecipeApi([]);
    const { user } = open(api);
    await user.click(await screen.findByRole("button", { name: "Add recipe" }));
    await user.type(screen.getByLabelText("Name"), "Garlic noodles");
    api.failNextWith = new RecipeApiError(400, ['Ingredient 1\'s unit "bucket" isn\'t a known unit.']);

    await user.click(screen.getByRole("button", { name: "Save recipe" }));

    expect((await screen.findByRole("alert")).textContent).toContain("bucket");
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Garlic noodles");
  });

  it("cancels back to the list without saving", async () => {
    const { api, user } = open(inMemoryRecipeApi([]));
    await user.click(await screen.findByRole("button", { name: "Add recipe" }));
    await user.type(screen.getByLabelText("Name"), "Never mind");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText(/No recipes yet/)).toBeTruthy();
    expect(api.recipes.size).toBe(0);
  });
});

describe("editing a recipe", () => {
  it("starts from what is saved and saves the changes", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Lentil soup");
    expect(screen.getByLabelText("Tags")).toHaveProperty("value", "quick, soup");
    expect(screen.getByLabelText("Food 1")).toHaveProperty("value", "Red lentils");
    expect(screen.getByLabelText("Step 2")).toHaveProperty("value", "Season and serve.");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Spicy lentil soup");
    await user.click(screen.getByRole("button", { name: "Remove ingredient 2" }));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Save recipe" }));

    expect(await screen.findByRole("heading", { name: "Spicy lentil soup" })).toBeTruthy();
    expect(api.recipes.get(lentilSoup.id)).toEqual({
      ...lentilSoup,
      name: "Spicy lentil soup",
      ingredients: [lentilSoup.ingredients[0]],
      steps: ["Season and serve."],
    });
  });
});

describe("deleting a recipe", () => {
  it("asks first, then removes it and returns to the list", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Flatbread" }));

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(api.recipes.has(flatbread.id)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Yes, delete Flatbread" }));

    await waitFor(() => expect(api.recipes.has(flatbread.id)).toBe(false));
    const list = await screen.findByRole("list", { name: "Recipes" });
    expect(within(list).queryByText("Flatbread")).toBeNull();
    expect(within(list).getByText("Lentil soup")).toBeTruthy();
  });

  it("keeps the recipe when the person changes their mind", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Flatbread" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await user.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.getByRole("heading", { name: "Flatbread" })).toBeTruthy();
    expect(api.recipes.has(flatbread.id)).toBe(true);
  });
});

describe("I made this", () => {
  it("logs the cook for the servings made and says what was used up", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    await user.click(await screen.findByRole("button", { name: "I made this" }));

    expect(api.cooks).toEqual([{ id: lentilSoup.id, servingsMade: 4 }]);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Logged");
    expect(status.textContent).toContain("100 g Flour");
  });

  it("sends the servings the person typed", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    const servings = await screen.findByLabelText("Servings made");
    await user.clear(servings);
    await user.type(servings, "2");
    await user.click(screen.getByRole("button", { name: "I made this" }));

    await screen.findByRole("status");
    expect(api.cooks).toEqual([{ id: lentilSoup.id, servingsMade: 2 }]);
  });

  it("says when the pantry ran short", async () => {
    const api = inMemoryRecipeApi();
    api.cookResult = { shortfalls: [{ food: "Red lentils", amount: 0.5, unit: "cup" }] };
    const { user } = open(api);
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    await user.click(await screen.findByRole("button", { name: "I made this" }));

    expect((await screen.findByRole("status")).textContent).toContain("Ran short: 0.5 cup Red lentils");
  });

  it("shows the problem and doesn't claim it was logged when the API refuses", async () => {
    const api = inMemoryRecipeApi();
    api.failCookWith = new RecipeApiError(503, ["Couldn't save that right now."]);
    const { user } = open(api);
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));

    await user.click(await screen.findByRole("button", { name: "I made this" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't save that right now.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("won't send non-positive servings", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("button", { name: "Lentil soup" }));
    const servings = await screen.findByLabelText("Servings made");
    await user.clear(servings);
    await user.type(servings, "0");

    await user.click(screen.getByRole("button", { name: "I made this" }));

    expect((await screen.findByRole("alert")).textContent).toContain("servings");
    expect(api.cooks).toEqual([]);
  });
});
