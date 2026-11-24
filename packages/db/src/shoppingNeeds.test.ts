import { describe, expect, it } from "vitest";
import { calculateNeeds, type PlannedLine, type StockLine } from "./shoppingNeeds.js";

// Made-up units and foods; ids are short strings.
const G = { unitId: "g", unit: "g", kind: "mass" };
const KG = { unitId: "kg", unit: "kg", kind: "mass" };
const TBSP = { unitId: "tbsp", unit: "tbsp", kind: "volume" };
const TSP = { unitId: "tsp", unit: "tsp", kind: "volume" };
const EA = { unitId: "ea", unit: "ea", kind: "count" };

const factors: Record<string, number> = { "kg>g": 1000, "g>kg": 0.001, "tbsp>tsp": 3, "tsp>tbsp": 1 / 3 };
const convert = (from: string, to: string): number | undefined => (from === to ? 1 : factors[`${from}>${to}`]);

const line = (food: string, quantity: number | null, unit: typeof G | null, recipeServings: number | null, plannedServings: number): PlannedLine => ({
  foodId: food.toLowerCase(),
  food,
  quantity,
  unitId: unit?.unitId ?? null,
  unit: unit?.unit ?? null,
  unitKind: unit?.kind ?? null,
  recipeServings,
  plannedServings,
});
const stock = (food: string, quantity: number, unit: typeof G): StockLine => ({
  foodId: food.toLowerCase(),
  quantity,
  unitId: unit.unitId,
  unitKind: unit.kind,
});
const summary = (needs: ReturnType<typeof calculateNeeds>) => needs.map((n) => `${n.food}: ${n.quantity ?? "-"} ${n.unit ?? ""}`.trim());

describe("calculateNeeds", () => {
  it("scales each recipe line by planned servings over recipe servings", () => {
    const needs = calculateNeeds([line("Lentils", 400, G, 4, 8), line("Flour", 300, G, null, 3)], [], convert);
    expect(summary(needs)).toEqual(["Flour: 300 g", "Lentils: 800 g"]);
  });

  it("sums a food across recipes, converting to the first unit seen", () => {
    const needs = calculateNeeds([line("Oil", 1, TBSP, 2, 2), line("Oil", 3, TSP, 2, 2), line("Rice", 1, KG, 1, 1), line("Rice", 500, G, 1, 1)], [], convert);
    expect(summary(needs)).toEqual(["Oil: 2 tbsp", "Rice: 1.5 kg"]);
  });

  it("lists unit kinds that can't be added together as separate lines", () => {
    const needs = calculateNeeds([line("Onion", 2, EA, 2, 2), line("Onion", 150, G, 2, 2)], [], convert);
    expect(summary(needs)).toEqual(["Onion: 2 ea", "Onion: 150 g"]);
  });

  it("leaves off a staple that is in stock, converting stock to the needed unit", () => {
    const needs = calculateNeeds([line("Lentils", 800, G, 1, 1)], [stock("Lentils", 1, KG)], convert);
    expect(needs).toEqual([]);
  });

  it("subtracts partial stock and only needs the rest", () => {
    const needs = calculateNeeds([line("Flour", 300, G, 1, 1)], [stock("Flour", 100, G)], convert);
    expect(summary(needs)).toEqual(["Flour: 200 g"]);
  });

  it("keeps a food with no stock record and a staple that has run out", () => {
    const needs = calculateNeeds([line("Honey", 2, TBSP, 1, 1), line("Flour", 100, G, 1, 1)], [stock("Flour", 0, G)], convert);
    expect(summary(needs)).toEqual(["Flour: 100 g", "Honey: 2 tbsp"]);
  });

  it("doesn't take stock counted in another kind of unit off the need", () => {
    const needs = calculateNeeds([line("Onion", 2, EA, 1, 1)], [stock("Onion", 500, G)], convert);
    expect(summary(needs)).toEqual(["Onion: 2 ea"]);
  });

  it("uses stock once across lines of one food, not once per recipe", () => {
    const needs = calculateNeeds([line("Flour", 300, G, 1, 1), line("Flour", 300, G, 1, 1)], [stock("Flour", 500, G)], convert);
    expect(summary(needs)).toEqual(["Flour: 100 g"]);
  });

  it("keeps 'to taste' foods without an amount, unless the food already has one", () => {
    const needs = calculateNeeds(
      [line("Salt", null, null, 1, 1), line("Pepper", null, null, 1, 1), line("Pepper", 2, G, 1, 1)],
      [],
      convert,
    );
    expect(summary(needs)).toEqual(["Pepper: 2 g", "Salt: -"]);
  });

  it("leaves a no-amount food off while its staple is in stock", () => {
    const needs = calculateNeeds([line("Salt", null, null, 1, 1)], [stock("Salt", 500, G)], convert);
    expect(needs).toEqual([]);
  });

  it("rounds away floating-point noise", () => {
    const needs = calculateNeeds([line("Milk", 0.1, KG, 1, 1), line("Milk", 0.2, KG, 1, 1)], [], convert);
    expect(needs[0]?.quantity).toBe(0.3);
  });
});
