import { matchUnit } from "@kitchen/db";
import { RECIPE_LIMITS, type RecipeIngredient, type Unit } from "@kitchen/shared";

/** What the household already has, for matching a page's wording to it. */
export interface Known {
  units: Unit[];
  /** The names in the household's food table. */
  foods: string[];
}

const FRACTIONS: Record<string, number> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5,
  "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const FRACTION = `[${Object.keys(FRACTIONS).join("")}]`;
// "1 1/2", "1½", "1/2", "½", "1,000", "2.5". Tried in this order, longest form first.
const NUMBER = `(?:\\d+ \\d+/\\d+|\\d+ ?${FRACTION}|\\d+/\\d+|${FRACTION}|\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?|\\.\\d+)`;
const QUANTITY = new RegExp(`^(${NUMBER})(?: ?(?:-|–|—|to) ?(${NUMBER}))?`);

/** How a recipe measures something the unit table has no unit for. These go in the note. */
const CONTAINERS = new Set(
  ["pinch", "dash", "clove", "can", "tin", "jar", "package", "packet", "pkg", "bunch", "sprig", "slice", "stick", "head", "handful", "stalk", "bag", "bottle", "box", "drop", "splash"]
    .flatMap((word) => [word, `${word}s`, `${word}es`]),
);
const SIZES = new Set(["small", "medium", "large", "heaping", "heaped", "rounded", "level", "scant"]);
/** Words that describe how a food is prepared or sized without making it a different food. */
const DESCRIPTORS = new Set([...SIZES, "fresh", "freshly", "finely", "roughly", "coarsely", "thinly", "chopped", "minced", "diced", "sliced", "grated", "ripe", "organic"]);
/** Words that can stand before a comma without naming a food: "boneless, skinless chicken". */
const ADJECTIVES = new Set([...DESCRIPTORS, "boneless", "skinless", "packed", "firmly", "lightly", "peeled", "seeded", "pitted", "cooked", "uncooked", "raw", "lean", "soft", "softened", "melted", "cold", "warm"]);
const TRAILING = / (to taste|for serving|for garnish|as needed|divided|optional)$/i;

function valueOf(number: string): number {
  const fraction = FRACTIONS[number.slice(-1)];
  if (fraction !== undefined) return Number(number.slice(0, -1).trim() || 0) + fraction;
  const mixed = /^(?:(\d+) )?(\d+)\/(\d+)$/.exec(number);
  if (mixed) return Number(mixed[1] ?? 0) + Number(mixed[2]) / Number(mixed[3]);
  return Number(number.replaceAll(",", ""));
}

/** A quantity the recipe table can hold (four decimals, above zero), or null. */
function storable(value: number): number | null {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Number.isFinite(rounded) && rounded > 0 && rounded <= RECIPE_LIMITS.number ? rounded : null;
}

const MIXED = new RegExp(`^(\\d+) ?(?:-|and|&) ?(\\d+/\\d+|${FRACTION})`);

/** One spelling for the ways pages write fractions: "1⁄2", "1-1/2", "1 and 1/2". */
const plainFractions = (line: string): string => line.replaceAll("\u2044", "/").replace(MIXED, "$1 $2");

/** Takes the bracketed asides out of a line, including doubled brackets. */
function withoutAsides(line: string): { rest: string; asides: string[] } {
  const asides: string[] = [];
  let rest = line;
  for (let depth = 0; depth < 3; depth++) {
    rest = rest.replace(/\(([^()]*)\)/g, (_, aside: string) => {
      if (aside.trim()) asides.push(aside.trim());
      return " ";
    });
  }
  return { rest: rest.replace(/\s+/g, " ").trim(), asides };
}

/** The spellings a food might be filed under: as written, singular and plural. */
function spellings(name: string): string[] {
  const lower = name.toLowerCase();
  return [lower, lower.replace(/ies$/, "y"), lower.replace(/es$/, ""), lower.replace(/s$/, ""), `${lower}s`, `${lower}es`];
}

/**
 * Reads one free-text ingredient line ("1 1/2 cups red lentils, rinsed") into a recipe
 * ingredient, using the household's own food and unit names where they match. Matching is
 * deliberately strict: "peanut butter" is not "butter". Null for a blank line. The line is
 * untrusted text from a web page, so every field is cut to what a recipe can hold.
 */
export function createIngredientParser({ units, foods }: Known): (line: string) => RecipeIngredient | null {
  const unitNames = new Map<string, string>();
  for (const unit of units) {
    unitNames.set(unit.name.toLowerCase(), unit.abbreviation);
    unitNames.set(unit.abbreviation.toLowerCase(), unit.abbreviation);
  }
  const foodNames = new Map(foods.map((name) => [name.toLowerCase(), name]));

  const unitFor = (word: string): string | undefined => {
    if (word === "T") return matchUnit(unitNames, "tbsp");
    if (word === "t") return matchUnit(unitNames, "tsp");
    return matchUnit(unitNames, word.replace(/\.$/, ""));
  };

  const knownFood = (name: string): string | undefined => {
    for (const spelling of spellings(name)) {
      const found = foodNames.get(spelling);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return (raw) => {
    const line = raw.slice(0, 1000).replace(/\s+/g, " ").replace(/^[\s▢□•*·-]+/, "").trim();
    if (line === "") return null;

    const notes: string[] = [];
    const aside = withoutAsides(plainFractions(line));
    const asides = aside.asides;
    let rest = aside.rest;

    let quantity: number | null = null;
    const amount = QUANTITY.exec(rest);
    // "2% milk" and "9-inch crust" start with a number that isn't an amount.
    if (amount?.[1] && !/^(%|-[a-z])/i.test(rest.slice(amount[0].length))) {
      quantity = storable(valueOf(amount[1]));
      if (amount[2]) notes.push(amount[0]);
      rest = rest.slice(amount[0].length).trim();
      // "2 x 400g tins": two of a 400 g thing.
      const each = /^[x×] ?(\d+(?:\.\d+)? ?(?:g|kg|ml|l|oz|lb))\b/i.exec(rest);
      if (each?.[1]) {
        notes.push(each[1]);
        rest = rest.slice(each[0].length).trim();
      }
    }

    let words = rest.split(" ");
    let unit: string | null = null;
    let article: string | null = null;
    if (quantity === null && /^an?$/i.test(words[0] ?? "") && CONTAINERS.has((words[1] ?? "").toLowerCase())) {
      article = words.shift() ?? null;
    }
    // "200 g/7oz": the first measure counts, the other goes in the note.
    const [first = "", other] = (words[0] ?? "").split(/\/(?=\d)/);
    if (quantity !== null && other !== undefined && unitFor(first) !== undefined) {
      words = [first, ...words.slice(1)];
      notes.push(other);
    }
    // "2 heaped tbsp": the size word comes before the unit.
    if (quantity !== null && words.length > 2 && SIZES.has((words[0] ?? "").toLowerCase()) && unitFor(words[1] ?? "") !== undefined) {
      notes.push(words[0] ?? "");
      words = words.slice(1);
    }
    if (quantity !== null && words.length > 2) {
      const two = unitFor(`${words[0]} ${words[1]}`);
      if (two !== undefined) {
        unit = two;
        words = words.slice(2);
      }
    }
    if (unit === null && quantity !== null && words.length > 1) {
      const one = unitFor(words[0] ?? "");
      if (one !== undefined) {
        unit = one;
        words = words.slice(1);
      }
    }
    let contained = false;
    if (unit === null) {
      const at = SIZES.has((words[0] ?? "").toLowerCase()) ? 1 : 0;
      if (words.length > at + 1 && CONTAINERS.has((words[at] ?? "").toLowerCase().replace(/\.$/, ""))) {
        notes.push([article, ...words.slice(0, at + 1)].filter(Boolean).join(" "));
        words = words.slice(at + 1);
        contained = true;
      }
    }
    if (words[0]?.toLowerCase() === "of") words = words.slice(1);

    const [opening = "", ...tail] = words.join(" ").split(",");
    let head = opening;
    while (tail.length > 0 && head.trim().split(" ").every((word) => ADJECTIVES.has(word.toLowerCase()))) {
      head = `${head.trim()} ${(tail.shift() ?? "").trim()}`;
    }
    let name = head.trim();
    let trailing: string | null = null;
    const ending = TRAILING.exec(name);
    if (ending) {
      trailing = ending[1] ?? null;
      name = name.slice(0, ending.index).trim();
    }

    let food = knownFood(name);
    if (food === undefined && !contained) {
      // "2 large tomatoes" is the household's "Tomato"; a can of diced tomatoes is not.
      const parts = name.split(" ");
      for (let skip = 1; skip < parts.length && DESCRIPTORS.has((parts[skip - 1] ?? "").toLowerCase()); skip++) {
        food = knownFood(parts.slice(skip).join(" "));
        if (food !== undefined) {
          notes.push(parts.slice(0, skip).join(" "));
          break;
        }
      }
    }
    food ??= name;

    // Nothing left to call a food: keep the whole line so the person can sort it out.
    if (food === "") return { food: line.slice(0, RECIPE_LIMITS.name), quantity: null, unit: null, note: null };

    const note = [...asides, ...notes, trailing, tail.join(",").trim()].filter(Boolean).join(", ");
    return { food: food.slice(0, RECIPE_LIMITS.name).trim(), quantity, unit, note: note.slice(0, RECIPE_LIMITS.note).trim() || null };
  };
}
