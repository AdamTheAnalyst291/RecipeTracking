import { describe, expect, it } from "vitest";
import { mapMealPlanEntry, mapRecipe, matchUnit, parseMinutes } from "./map.js";

describe("parseMinutes", () => {
  it.each([
    ["1 Hour 30 Minutes", 90],
    ["45 minutes", 45],
    ["PT1H30M", 90],
    ["2 hours", 120],
    ["30", 30],
    ["", null],
    ["soon", null],
  ])("reads %j as %j", (input, expected) => {
    expect(parseMinutes(input)).toBe(expected);
  });
});

describe("mapRecipe", () => {
  it("falls back to prep + cook time and a yield number, and drops blank steps", () => {
    const recipe = mapRecipe(
      { id: "x", name: "Bread", recipeYield: "2 loaves", prepTime: "20 minutes", performTime: "40 minutes", recipeInstructions: [{ text: " " }, { text: "Bake." }] },
      [],
    );
    expect(recipe).toMatchObject({ servings: 2, totalMinutes: 60, steps: ["Bake."] });
  });

  it("keeps an unparsed ingredient line as a food and says so", () => {
    const problems: string[] = [];
    const recipe = mapRecipe({ id: "x", name: "Soup", recipeIngredient: [{ food: null, note: "", originalText: "salt to taste" }] }, problems);
    expect(recipe?.ingredients).toEqual([{ food: "salt to taste", quantity: null, unit: null, note: null }]);
    expect(problems).toHaveLength(1);
  });

  it("skips a recipe with no name", () => {
    const problems: string[] = [];
    expect(mapRecipe({ id: "x" }, problems)).toBeNull();
    expect(problems).toHaveLength(1);
  });

  it("uses the web site as the credit and merges tags and categories without repeats", () => {
    const recipe = mapRecipe(
      { id: "x", name: "A", orgURL: "https://www.site.test/a", tags: [{ name: "Soup" }], recipeCategory: [{ name: "soup" }, { name: "Dinner" }] },
      [],
    );
    expect(recipe).toMatchObject({ sourceCredit: "site.test", tags: ["Soup", "Dinner"] });
  });
});

describe("mapMealPlanEntry", () => {
  it("plans a side as dinner and says so", () => {
    const problems: string[] = [];
    expect(mapMealPlanEntry({ id: "m", date: "2026-11-24", entryType: "side", recipeId: "r" }, problems)).toMatchObject({ slot: "dinner" });
    expect(problems).toHaveLength(1);
  });

  it("skips a note-only entry and a bad date", () => {
    const problems: string[] = [];
    expect(mapMealPlanEntry({ id: "m", date: "2026-11-24", entryType: "dinner", title: "Out" }, problems)).toBeNull();
    expect(mapMealPlanEntry({ id: "m", date: "2026-02-31", entryType: "dinner", recipeId: "r" }, problems)).toBeNull();
    expect(problems).toHaveLength(2);
  });
});

describe("matchUnit", () => {
  const ids = new Map([["cup", "U1"], ["tbsp", "U2"], ["g", "U3"], ["gram", "U3"]]);
  it("matches names, plurals and abbreviations, and returns nothing for an unknown unit", () => {
    expect(matchUnit(ids, "Cups")).toBe("U1");
    expect(matchUnit(ids, "tablespoons")).toBe("U2");
    expect(matchUnit(ids, "Gram")).toBe("U3");
    expect(matchUnit(ids, "clove")).toBeUndefined();
  });
});
