import type { Unit } from "@kitchen/shared";
import { describe, expect, it } from "vitest";
import { createIngredientParser } from "./ingredientLine.js";

const units: Unit[] = [
  { name: "gram", abbreviation: "g" },
  { name: "ounce", abbreviation: "oz" },
  { name: "teaspoon", abbreviation: "tsp" },
  { name: "tablespoon", abbreviation: "tbsp" },
  { name: "fluid ounce", abbreviation: "fl oz" },
  { name: "cup", abbreviation: "cup" },
  { name: "each", abbreviation: "ea" },
];
const parse = createIngredientParser({ units, foods: ["Red lentils", "Garlic", "Tomato", "Flour", "Butter", "Basil", "Egg"] });

describe("reading an ingredient line", () => {
  it.each([
    ["1 1/2 cups red lentils, rinsed", { food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" }],
    ["1½ cups red lentils", { food: "Red lentils", quantity: 1.5, unit: "cup", note: null }],
    ["⅓ cup flour", { food: "Flour", quantity: 0.3333, unit: "cup", note: null }],
    ["250g flour", { food: "Flour", quantity: 250, unit: "g", note: null }],
    ["1,000 grams flour", { food: "Flour", quantity: 1000, unit: "g", note: null }],
    ["2 Tbsp. butter", { food: "Butter", quantity: 2, unit: "tbsp", note: null }],
    ["1 T butter", { food: "Butter", quantity: 1, unit: "tbsp", note: null }],
    ["8 fluid ounces water", { food: "water", quantity: 8, unit: "fl oz", note: null }],
    ["3 eggs", { food: "Egg", quantity: 3, unit: null, note: null }],
    ["2 large tomatoes", { food: "Tomato", quantity: 2, unit: null, note: "large" }],
    ["▢ 2 cloves garlic, minced", { food: "Garlic", quantity: 2, unit: null, note: "cloves, minced" }],
    ["1 (14 oz) can diced tomatoes", { food: "diced tomatoes", quantity: 1, unit: null, note: "14 oz, can" }],
    ["2-3 tbsp butter", { food: "Butter", quantity: 2, unit: "tbsp", note: "2-3" }],
    ["a pinch of saffron", { food: "saffron", quantity: null, unit: null, note: "a pinch" }],
    ["Salt to taste", { food: "Salt", quantity: null, unit: null, note: "to taste" }],
    ["2% milk", { food: "2% milk", quantity: null, unit: null, note: null }],
  ])("%s", (line, expected) => {
    expect(parse(line)).toEqual(expected);
  });

  it("does not match a food that only shares a word", () => {
    expect(parse("2 tbsp peanut butter")?.food).toBe("peanut butter");
    expect(parse("1 tsp dried basil")?.food).toBe("dried basil");
  });

  it("has nothing to say about a blank line", () => {
    expect(parse("  ▢ ")).toBeNull();
  });

  it("keeps an absurdly long line within the recipe limits", () => {
    const line = parse(`1 cup ${"x".repeat(5000)}, ${"y".repeat(5000)}`);

    expect(line?.food.length).toBeLessThanOrEqual(200);
    expect(line?.note?.length ?? 0).toBeLessThanOrEqual(500);
  });
});
