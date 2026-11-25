import { readFileSync } from "node:fs";
import { parseRecipeInput, type Unit } from "@kitchen/shared";
import { describe, expect, it } from "vitest";
import { readRecipePage } from "./recipePage.js";

// Made-up pages; the repo is public.
const page = (name: string) => readFileSync(new URL(`../../test/pages/${name}.html`, import.meta.url), "utf8");
const units: Unit[] = [
  { name: "gram", abbreviation: "g" },
  { name: "teaspoon", abbreviation: "tsp" },
  { name: "cup", abbreviation: "cup" },
];
const known = { units, foods: ["Red lentils", "Garlic", "Flour"] };
const url = "https://www.recipes.example/stew";

const jsonLd = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const read = (html: string) => readRecipePage(html, url, known);

describe("reading a recipe from a page", () => {
  it("drafts the recipe from its JSON-LD, matching foods the household has", () => {
    expect(read(page("plain-recipe"))).toEqual({
      ok: true,
      newFoods: ["diced tomatoes", "Salt"],
      recipe: {
        name: "Weeknight Lentil Stew",
        servings: 6,
        totalMinutes: 75,
        sourceUrl: url,
        sourceCredit: "Made-up Cook",
        tags: ["Dinner", "Homestyle", "stew", "lentils"],
        ingredients: [
          { food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" },
          { food: "Garlic", quantity: 2, unit: null, note: "cloves, minced" },
          { food: "diced tomatoes", quantity: 1, unit: null, note: "14 oz, can" },
          { food: "Salt", quantity: null, unit: null, note: "to taste" },
        ],
        steps: ["Rinse the lentils.", "Simmer everything for an hour & season."],
      },
    });
  });

  it("finds the recipe inside an @graph, with sectioned steps and a referenced author", () => {
    const result = read(page("graph-recipe"));

    expect(result.ok && result.recipe).toMatchObject({
      name: "Skillet Flatbread",
      servings: 4,
      totalMinutes: 25,
      sourceCredit: "Invented Chef",
      ingredients: [
        { food: "Flour", quantity: 250, unit: "g", note: null },
        { food: "salt", quantity: 1, unit: "tsp", note: null },
        { food: "water", quantity: 0.6667, unit: "cup", note: null },
      ],
      steps: ["Mix the flour and salt.", "Add the water and knead.", "Fry each side until spotted."],
    });
  });

  it("finds a recipe in a top-level array, or as a page's main entity", () => {
    const recipe = { "@type": "http://schema.org/Recipe", name: "Toast", recipeInstructions: "Slice.\nToast." };

    for (const data of [[{ "@type": "BreadcrumbList" }, recipe], { "@type": "WebPage", mainEntity: recipe }]) {
      const result = read(jsonLd(data));
      expect(result.ok && result.recipe).toMatchObject({ name: "Toast", sourceCredit: "recipes.example", steps: ["Slice.", "Toast."] });
    }
  });

  it("reads JSON-LD that has raw line breaks inside a string", () => {
    const result = read('<script type="application/ld+json">{"@type":"Recipe","name":"Two\nLine Pie"}</script>');

    expect(result.ok && result.recipe.name).toBe("Two Line Pie");
  });

  it("says there is no recipe data on a page without it", () => {
    expect(read(page("no-recipe"))).toEqual({ ok: false, reason: "none" });
    expect(read("<html><body>Just words</body></html>")).toEqual({ ok: false, reason: "none" });
  });

  it("says the recipe data is broken when it can't be parsed", () => {
    expect(read(page("malformed-recipe"))).toEqual({ ok: false, reason: "broken" });
  });

  it("says the recipe data is incomplete when the recipe has no name", () => {
    expect(read(jsonLd({ "@type": "Recipe", recipeIngredient: ["1 cup flour"] }))).toEqual({ ok: false, reason: "incomplete" });
  });

  it("always drafts something that passes the recipe checks, however oversized the page's data", () => {
    const result = read(
      jsonLd({
        "@type": "Recipe",
        name: "N".repeat(1000),
        author: "A".repeat(1000),
        recipeYield: "99999999999",
        totalTime: "PT999999999H",
        keywords: Array.from({ length: 500 }, (_, i) => `tag ${i}`),
        recipeIngredient: Array.from({ length: 500 }, (_, i) => `${i} cup thing ${i}`),
        recipeInstructions: ["S".repeat(10_000), 42, null, { text: ["not text"] }],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && parseRecipeInput(result.recipe).ok).toBe(true);
  });

  it("reads the long form of a duration", () => {
    const result = read(jsonLd({ "@type": "Recipe", name: "Eggs", totalTime: "P0Y0M0DT0H35M0.000S" }));

    expect(result.ok && result.recipe.totalMinutes).toBe(35);
  });

  it("leaves unknown entities alone, even ones named like object internals", () => {
    const result = read(jsonLd({ "@type": "Recipe", name: "Pie &toString; &constructor;" }));

    expect(result.ok && result.recipe.name).toBe("Pie &toString; &constructor;");
  });

  it("stays quick when a page lists thousands of authors by reference", () => {
    const html = jsonLd([
      { "@type": "Recipe", name: "Soup", author: Array.from({ length: 100_000 }, () => ({ "@id": "z" })) },
      Array.from({ length: 20_000 }, (_, i) => ({ "@id": `n${i}` })),
    ]);
    const started = Date.now();

    read(html);

    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stays quick on a page built to make parsing slow", () => {
    const hostile = jsonLd({ "@type": "Recipe", name: "<a".repeat(200_000), recipeIngredient: [`1${" ".repeat(200_000)}x`] });
    const started = Date.now();

    read("<script ".repeat(50_000));
    read(hostile);

    expect(Date.now() - started).toBeLessThan(2000);
  });
});
