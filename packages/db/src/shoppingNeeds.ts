/**
 * What a stretch of the meal plan needs from the shop. Pure arithmetic, no database: the
 * caller reads the planned recipe lines and the staples' stock, this totals and subtracts.
 */

/** One recipe ingredient line of a planned meal. `quantity` and the unit are null for "to taste". */
export interface PlannedLine {
  foodId: string;
  food: string;
  quantity: number | null;
  unitId: string | null;
  unit: string | null;
  unitKind: string | null;
  /** The recipe's servings, or null when it doesn't say (then the line isn't scaled). */
  recipeServings: number | null;
  plannedServings: number;
}

/** A staple product's stock. Only staples are tracked, so only staples come in here. */
export interface StockLine {
  foodId: string;
  quantity: number;
  unitId: string;
  unitKind: string;
}

/** One line to buy. `quantity`, `unitId` and `unit` are null for a food with no amount. */
export interface Need {
  foodId: string;
  food: string;
  quantity: number | null;
  unitId: string | null;
  unit: string | null;
}

/** How many `to` one `from` is, or undefined when they aren't the same kind of unit. */
export type Convert = (fromUnitId: string, toUnitId: string) => number | undefined;

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface Group {
  foodId: string;
  food: string;
  kind: string | null; // null: no unit
  unitId: string | null;
  unit: string | null;
  quantity: number | null; // null: only "to taste" lines
}

/**
 * Totals each food over the planned lines (scaled by planned servings ÷ recipe servings,
 * converted to the first unit seen for that food and kind), then takes off the stock held in
 * staples. Foods with no stock record are kept ("assume we need it"), as are staples that
 * have run out. Amounts in unit kinds that can't be added (grams and a count) are separate
 * lines, and stock counted in another kind never reduces them.
 */
export function calculateNeeds(lines: PlannedLine[], stock: StockLine[], convert: Convert): Need[] {
  const groups: Group[] = [];

  for (const l of lines) {
    const kind = l.unitId === null ? null : l.unitKind;
    const scale = l.recipeServings ? l.plannedServings / l.recipeServings : 1;
    let group = groups.find((g) => same(g.foodId, l.foodId) && g.kind === kind);
    if (!group) {
      group = { foodId: l.foodId, food: l.food, kind, unitId: l.unitId, unit: l.unit, quantity: null };
      groups.push(group);
    }
    if (l.quantity === null) continue;
    let amount = l.quantity * scale;
    if (group.unitId !== null && l.unitId !== null && !same(group.unitId, l.unitId)) {
      const f = convert(l.unitId, group.unitId);
      if (f === undefined) continue; // same kind but no conversion: shouldn't happen with the unit table
      amount *= f;
    }
    group.quantity = (group.quantity ?? 0) + amount;
  }

  const needs: Need[] = [];
  for (const group of groups) {
    const foodStock = stock.filter((s) => same(s.foodId, group.foodId));

    if (group.quantity === null) {
      // "To taste": drop it when the food has an amount somewhere else, or its staple is in stock.
      if (groups.some((g) => g !== group && same(g.foodId, group.foodId) && g.quantity !== null)) continue;
      if (foodStock.some((s) => s.quantity > 0)) continue;
      needs.push({ foodId: group.foodId, food: group.food, quantity: null, unitId: null, unit: null });
      continue;
    }

    let remaining = round4(group.quantity);
    if (group.unitId !== null) {
      for (const s of foodStock) {
        const f = same(s.unitId, group.unitId) ? 1 : convert(s.unitId, group.unitId);
        if (f !== undefined) remaining = round4(remaining - s.quantity * f);
      }
    }
    if (remaining <= 0) continue;
    needs.push({ foodId: group.foodId, food: group.food, quantity: remaining, unitId: group.unitId, unit: group.unit });
  }

  return needs.sort((a, b) => a.food.localeCompare(b.food) || (a.unit ?? "").localeCompare(b.unit ?? ""));
}
