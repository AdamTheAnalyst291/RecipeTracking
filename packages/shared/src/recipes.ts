/** One line of a recipe's ingredient list. The food and unit are named, not identified: the API finds or adds the food. */
export interface RecipeIngredient {
  /** Name of a food in the household's shared food table, like "Red lentils". */
  food: string;
  quantity: number | null;
  /** A unit's name or abbreviation from `GET /api/units`, like "cup" or "g". */
  unit: string | null;
  note: string | null;
}

/** What a person writes when they add or edit a recipe. */
export interface RecipeInput {
  name: string;
  servings: number | null;
  totalMinutes: number | null;
  sourceUrl: string | null;
  sourceCredit: string | null;
  tags: string[];
  ingredients: RecipeIngredient[];
  steps: string[];
}

export interface Recipe extends RecipeInput {
  id: string;
}

/** A recipe as the browse list shows it. */
export interface RecipeSummary {
  id: string;
  name: string;
  servings: number | null;
  totalMinutes: number | null;
  tags: string[];
}

export interface RecipeListResponse {
  recipes: RecipeSummary[];
}

/** Body of `POST /api/recipe-import`: the recipe page to read. */
export interface RecipeImportRequest {
  url: string;
}

/** A recipe read from a web page, not yet saved: the person checks it, then saves it as usual. */
export interface RecipeImportResponse {
  recipe: RecipeInput;
  /** Foods the draft names that the household doesn't have yet; saving adds them. */
  newFoods: string[];
}

export interface Unit {
  name: string;
  abbreviation: string;
}

export interface UnitListResponse {
  units: Unit[];
}

export type ParsedRecipe = { ok: true; value: RecipeInput } | { ok: false; errors: string[] };

/** The most each recipe field holds: characters of text, lines of a list, or the largest number. */
export const RECIPE_LIMITS = { name: 200, tag: 50, url: 2000, credit: 200, note: 500, step: 4000, lines: 200, number: 1_000_000 } as const;
const { name: MAX_NAME, tag: MAX_TAG, url: MAX_URL, credit: MAX_CREDIT, note: MAX_NOTE, step: MAX_STEP, lines: MAX_LINES, number: MAX_NUMBER } = RECIPE_LIMITS;

type Fields = Record<string, unknown>;

/**
 * Checks and tidies a recipe a person submitted: text is trimmed, empty optional fields become
 * null, repeated tags (ignoring case) collapse to the first. Used by the API to refuse bad
 * input, and by the edit screen to say what's wrong before sending.
 */
export function parseRecipeInput(body: unknown): ParsedRecipe {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["The recipe must be an object."] };
  }
  const input = body as Fields;
  const errors: string[] = [];

  const text = (value: unknown, label: string, max: number, required: boolean): string | null => {
    if (value === undefined || value === null) {
      if (required) errors.push(`${label} is required.`);
      return null;
    }
    if (typeof value !== "string") {
      errors.push(`${label} must be text.`);
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      if (required) errors.push(`${label} is required.`);
      return null;
    }
    if (trimmed.length > max) {
      errors.push(`${label} must be at most ${max} characters.`);
      return null;
    }
    return trimmed;
  };

  const wholeNumber = (value: unknown, label: string, min: number): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > MAX_NUMBER) {
      errors.push(`${label} must be a whole number of at least ${min}.`);
      return null;
    }
    return value;
  };

  const list = (value: unknown, label: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_LINES) {
      errors.push(`${label} must be a list of at most ${MAX_LINES}.`);
      return [];
    }
    return value;
  };

  const name = text(input.name, "Name", MAX_NAME, true);
  const servings = wholeNumber(input.servings, "Servings", 1);
  const totalMinutes = wholeNumber(input.totalMinutes, "Total time", 0);
  const sourceCredit = text(input.sourceCredit, "Credit", MAX_CREDIT, false);

  let sourceUrl = text(input.sourceUrl, "Source link", MAX_URL, false);
  if (sourceUrl !== null) {
    let protocol = "";
    try {
      protocol = new URL(sourceUrl).protocol;
    } catch {
      // falls through to the error below
    }
    if (protocol !== "http:" && protocol !== "https:") {
      errors.push("Source link must be an http or https address.");
      sourceUrl = null;
    }
  }

  const tags: string[] = [];
  for (const raw of list(input.tags, "Tags")) {
    const tag = text(raw, "A tag", MAX_TAG, true);
    if (tag !== null && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }

  const ingredients: RecipeIngredient[] = [];
  list(input.ingredients, "Ingredients").forEach((raw, i) => {
    const label = `Ingredient ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    const line = raw as Fields;
    const food = text(line.food, `${label}'s food`, MAX_NAME, true);
    const unit = text(line.unit, `${label}'s unit`, 50, false);
    const note = text(line.note, `${label}'s note`, MAX_NOTE, false);
    let quantity: number | null = null;
    if (line.quantity !== undefined && line.quantity !== null) {
      if (typeof line.quantity !== "number" || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > MAX_NUMBER) {
        errors.push(`${label}'s quantity must be a number above zero.`);
      } else {
        quantity = line.quantity;
      }
    }
    if (food !== null) ingredients.push({ food, quantity, unit, note });
  });

  const steps: string[] = [];
  list(input.steps, "Steps").forEach((raw, i) => {
    const step = text(raw, `Step ${i + 1}`, MAX_STEP, true);
    if (step !== null) steps.push(step);
  });

  if (errors.length > 0 || name === null) return { ok: false, errors };
  return { ok: true, value: { name, servings, totalMinutes, sourceUrl, sourceCredit, tags, ingredients, steps } };
}
