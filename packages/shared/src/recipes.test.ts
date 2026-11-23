import { describe, expect, it } from "vitest";
import { parseRecipeInput } from "./recipes.js";

const valid = {
  name: "  Lentil soup ",
  servings: 4,
  totalMinutes: 45,
  sourceUrl: "https://example.com/lentil-soup",
  sourceCredit: "Made-up Cookbook",
  tags: ["Soup", "soup", " quick "],
  ingredients: [
    { food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" },
    { food: "Salt", quantity: null, unit: null, note: null },
  ],
  steps: ["Simmer the lentils.", "  Season and serve. "],
};

describe("parseRecipeInput", () => {
  it("trims text, drops duplicate tags and keeps the order of ingredients and steps", () => {
    const result = parseRecipeInput(valid);

    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        name: "Lentil soup",
        tags: ["Soup", "quick"],
        steps: ["Simmer the lentils.", "Season and serve."],
      },
    });
  });

  it("fills in what a bare recipe leaves out", () => {
    expect(parseRecipeInput({ name: "Toast" })).toEqual({
      ok: true,
      value: { name: "Toast", servings: null, totalMinutes: null, sourceUrl: null, sourceCredit: null, tags: [], ingredients: [], steps: [] },
    });
  });

  it.each([
    ["not an object", "soup"],
    ["no name", { ...valid, name: "   " }],
    ["a name that is too long", { ...valid, name: "x".repeat(201) }],
    ["zero servings", { ...valid, servings: 0 }],
    ["fractional servings", { ...valid, servings: 2.5 }],
    ["a negative time", { ...valid, totalMinutes: -5 }],
    ["a source link that isn't http(s)", { ...valid, sourceUrl: "javascript:alert(1)" }],
    ["tags that aren't a list", { ...valid, tags: "soup" }],
    ["an ingredient with no food", { ...valid, ingredients: [{ food: "", quantity: 1, unit: null, note: null }] }],
    ["a quantity of zero", { ...valid, ingredients: [{ food: "Salt", quantity: 0, unit: null, note: null }] }],
    ["a blank step", { ...valid, steps: ["Stir.", "  "] }],
  ])("rejects %s", (_name, body) => {
    const result = parseRecipeInput(body);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});
