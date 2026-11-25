import { createHash } from "node:crypto";
import { MEAL_SLOTS, type MealSlot } from "../mealPlan.js";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface MappedIngredient {
  food: string;
  quantity: number | null;
  /** A unit name or abbreviation from Mealie, looked up against the unit table when written. */
  unit: string | null;
  note: string | null;
}

export interface MappedRecipe {
  mealieId: string;
  name: string;
  servings: number | null;
  totalMinutes: number | null;
  sourceUrl: string | null;
  sourceCredit: string | null;
  tags: string[];
  ingredients: MappedIngredient[];
  steps: string[];
}

export interface MappedMeal {
  mealieId: string;
  date: string;
  slot: MealSlot;
  mealieRecipeId: string;
}

/** Lines for the report: things the importer could not carry over exactly. */
export type Problems = string[];

/** Mealie's free-text durations: "1 Hour 30 Minutes", "45 minutes", "PT1H30M", or a bare number of minutes. */
export function parseMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const s = text(value).toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const iso = /^pt(?:(\d+)h)?(?:(\d+)m)?(?:\d+s)?$/.exec(s);
  if (iso) return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
  const days = /(\d+(?:\.\d+)?)\s*d(?:ay)?s?\b/.exec(s);
  const hours = /(\d+(?:\.\d+)?)\s*h(?:our|r)?s?\b/.exec(s);
  const minutes = /(\d+(?:\.\d+)?)\s*m(?:inute|in)?s?\b/.exec(s);
  if (!days && !hours && !minutes) return null;
  return Math.round(Number(days?.[1] ?? 0) * 1440 + Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0));
}

function servingsOf(raw: Json): number | null {
  const direct = raw.recipeServings;
  if (typeof direct === "number" && direct > 0) return Math.max(1, Math.round(direct));
  const fromYield = /\d+/.exec(text(raw.recipeYield) || text(raw.recipeYieldQuantity));
  return fromYield ? Math.max(1, Number(fromYield[0])) : null;
}

/** Cuts text to a column's length, noting it in the report when something was lost. */
function fit(value: string, max: number, what: string, problems: Problems): string {
  if (value.length <= max) return value;
  problems.push(`${what} is longer than ${max} characters and was cut short.`);
  return value.slice(0, max);
}

/** Turns one Mealie recipe (full detail) into the kitchen app's shape; null when it has no usable name or id. */
export function mapRecipe(raw: Json, problems: Problems): MappedRecipe | null {
  const mealieId = text(raw.id);
  const name = text(raw.name);
  if (!mealieId || !name) {
    problems.push(`A recipe (${mealieId || text(raw.slug) || "no id"}) has no name or id and was skipped.`);
    return null;
  }
  const label = `Recipe "${name}"`;

  const total = parseMinutes(raw.totalTime);
  const parts = (parseMinutes(raw.prepTime) ?? 0) + (parseMinutes(raw.performTime) ?? 0);
  const totalMinutes = total ?? (parts > 0 ? parts : null);

  const sourceUrl = text(raw.orgURL) || null;
  let sourceCredit: string | null = null;
  if (sourceUrl) {
    try {
      sourceCredit = new URL(sourceUrl).hostname.replace(/^www\./, "").slice(0, 200);
    } catch {
      sourceCredit = null;
    }
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const group of [raw.tags, raw.recipeCategory]) {
    for (const item of Array.isArray(group) ? group : []) {
      const tag = fit(isObject(item) ? text(item.name) : "", 50, `${label} tag`, problems);
      if (tag && !seen.has(tag.toLowerCase())) {
        seen.add(tag.toLowerCase());
        tags.push(tag);
      }
    }
  }

  const ingredients: MappedIngredient[] = [];
  for (const item of Array.isArray(raw.recipeIngredient) ? raw.recipeIngredient : []) {
    if (!isObject(item)) continue;
    const note = text(item.note);
    const original = text(item.originalText) || text(item.display);
    const foodName = isObject(item.food) ? text(item.food.name) : "";
    const unitRaw = isObject(item.unit) ? text(item.unit.name) || text(item.unit.abbreviation) : "";
    const quantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : null;

    if (!foodName) {
      // An unparsed line ("2 cups flour"): keep the whole line as the food so nothing is lost.
      const line = original || note;
      if (!line) continue;
      problems.push(`${label}: ingredient "${line}" has no food, so the whole line became a food.`);
      ingredients.push({ food: fit(line, 200, `${label} ingredient`, problems), quantity: null, unit: null, note: null });
      continue;
    }
    ingredients.push({
      food: fit(foodName, 200, `${label} food`, problems),
      quantity,
      unit: unitRaw || null,
      note: note ? fit(note, 500, `${label} ingredient note`, problems) : null,
    });
  }

  const steps: string[] = [];
  for (const item of Array.isArray(raw.recipeInstructions) ? raw.recipeInstructions : []) {
    const step = isObject(item) ? text(item.text) : "";
    if (step) steps.push(fit(step, 4000, `${label} step ${steps.length + 1}`, problems));
  }

  return {
    mealieId,
    name: fit(name, 200, `${label} name`, problems),
    servings: servingsOf(raw),
    totalMinutes,
    sourceUrl: sourceUrl && sourceUrl.length <= 2000 ? sourceUrl : null,
    sourceCredit,
    tags,
    ingredients,
    steps,
  };
}

/** Mealie's other entry types, and the slot they are planned in. */
const SLOT_OF: Record<string, MealSlot> = { side: "dinner", dessert: "dinner" };

/** A planned meal from a Mealie entry; null (and a report line) for entries that can't be a planned recipe. */
export function mapMealPlanEntry(raw: Json, problems: Problems): MappedMeal | null {
  const mealieId = text(raw.id);
  const date = text(raw.date).slice(0, 10);
  const what = `Meal plan entry ${date || mealieId}`;
  const title = text(raw.title);
  const recipeId = text(raw.recipeId) || (isObject(raw.recipe) ? text(raw.recipe.id) : "");
  if (!recipeId) {
    problems.push(`${what}${title ? ` ("${title}")` : ""} is a note, not a recipe, so it was skipped.`);
    return null;
  }
  const entryType = text(raw.entryType).toLowerCase();
  const slot = (MEAL_SLOTS as readonly string[]).includes(entryType) ? (entryType as MealSlot) : SLOT_OF[entryType];
  if (!slot) {
    problems.push(`${what} has an unknown meal type "${entryType}" and was skipped.`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    problems.push(`${what} has no valid date and was skipped.`);
    return null;
  }
  if (!mealieId) {
    problems.push(`${what} has no id and was skipped.`);
    return null;
  }
  if (entryType in SLOT_OF) problems.push(`${what} was a "${entryType}"; it was planned as ${slot}.`);
  return { mealieId, date, slot, mealieRecipeId: recipeId };
}

/** Changes whenever anything the importer would write for this item changes. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Other names a unit might go by (in Mealie or on a recipe web page), to the abbreviations in the unit table. */
const UNIT_ALIASES: Record<string, string> = {
  grams: "g", gram: "g", gr: "g", kilograms: "kg", kilogram: "kg", ounces: "oz", ounce: "oz",
  pounds: "lb", pound: "lb", lbs: "lb", millilitres: "ml", milliliters: "ml", millilitre: "ml", milliliter: "ml",
  litres: "l", liters: "l", litre: "l", liter: "l", teaspoons: "tsp", teaspoon: "tsp", tsps: "tsp",
  tablespoons: "tbsp", tablespoon: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp",
  "fluid ounces": "fl oz", "fl. oz": "fl oz", cups: "cup", c: "cup",
  pieces: "ea", piece: "ea", whole: "ea",
};

/** What `unitIds` holds for a unit name (it is keyed by lower-case name and abbreviation), or undefined. */
export function matchUnit(unitIds: ReadonlyMap<string, string>, name: string): string | undefined {
  const key = name.trim().toLowerCase();
  const alias = UNIT_ALIASES[key];
  return unitIds.get(key) ?? (alias === undefined ? undefined : unitIds.get(alias));
}
