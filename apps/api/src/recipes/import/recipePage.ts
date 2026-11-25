import type { RecipeInput } from "@kitchen/shared";
import { createIngredientParser, type Known } from "./ingredientLine.js";

/**
 * Reads the schema.org `Recipe` in a page's JSON-LD into a draft recipe. Only those script
 * blocks are read, never the rest of the page. Everything in them is untrusted data: it is
 * only ever copied into recipe fields, as plain text, cut to the fields' limits.
 */
export type ReadPage =
  | { ok: true; recipe: RecipeInput; /** Foods the draft names that the household doesn't have yet. */ newFoods: string[] }
  /** `none`: no recipe data. `broken`: data that can't be parsed. `incomplete`: a recipe with no name. */
  | { ok: false; reason: "none" | "broken" | "incomplete" };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const MAX_BLOCKS = 50;
const MAX_NODES = 20_000;
const MAX_LINES = 200;
const MAX_TAGS = 20;

/** The contents of every `<script type="application/ld+json">`. Scans forward only. */
function jsonLdBlocks(html: string): string[] {
  const open = /<script\b/gi;
  const close = /<\/script/gi;
  const blocks: string[] = [];
  while (blocks.length < MAX_BLOCKS && open.exec(html)) {
    const tagEnd = html.indexOf(">", open.lastIndex);
    if (tagEnd < 0) break;
    close.lastIndex = tagEnd + 1;
    const end = close.exec(html);
    if (!end) break;
    if (/\btype\s*=\s*["']?\s*application\/ld\+json\b/i.test(html.slice(open.lastIndex, tagEnd))) {
      blocks.push(html.slice(tagEnd + 1, end.index));
    }
    open.lastIndex = close.lastIndex;
  }
  return blocks;
}

function parseBlock(block: string): unknown {
  const json = block.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/;$/, "");
  try {
    return JSON.parse(json);
  } catch {
    try {
      // The commonest fault: raw line breaks or tabs inside a string.
      return JSON.parse(json.replace(/\p{Cc}+/gu, " "));
    } catch {
      return undefined;
    }
  }
}

/** Every object in the data, however nested (arrays, `@graph`, `mainEntity`), nearest the top first. */
function nodesOf(roots: unknown[]): Json[] {
  const queue = [...roots];
  const nodes: Json[] = [];
  for (let i = 0; i < queue.length && i < MAX_NODES; i++) {
    const value = queue[i];
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_NODES)) queue.push(item);
    } else if (isObject(value)) {
      nodes.push(value);
      for (const child of Object.values(value)) {
        if (typeof child === "object" && child !== null) queue.push(child);
      }
    }
  }
  return nodes;
}

const isRecipe = (node: Json) => listOf(node["@type"]).some((t) => typeof t === "string" && /(^|[/:])Recipe$/.test(t));

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", deg: "°",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", frac12: "½", frac14: "¼", frac34: "¾",
  frac13: "⅓", frac23: "⅔", frac18: "⅛", times: "×", eacute: "é", egrave: "è", ntilde: "ñ",
};

const decode = (text: string) =>
  text.replace(/&(#x?[0-9a-f]{1,6}|[a-z][a-z0-9]{1,8});/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? whole;
    const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/** Text that may hold HTML, as lines of plain text. */
function lines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return decode(value.slice(0, 50_000))
    .replace(/<(br|\/p|\/li|\/div)\b[^<>]*>/gi, "\n")
    .replace(/<\/?[a-z][^<>]*>/gi, " ")
    .split("\n")
    .map((line) => line.replace(/[\s\p{Cc}]+/gu, " ").trim())
    .filter((line) => line !== "");
}

const plain = (value: unknown): string => lines(typeof value === "number" ? String(value) : value).join(" ");
const cut = (text: string, max: number): string => text.slice(0, max).trim();

/** Minutes in an ISO 8601 duration like `PT1H30M`, or null. */
function minutesOf(value: unknown): number | null {
  const parts = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(plain(value));
  if (!parts || parts.slice(1).every((p) => p === undefined)) return null;
  const minutes = Number(parts[1] ?? 0) * 1440 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return minutes > 0 && minutes <= 1_000_000 ? minutes : null;
}

function servingsOf(value: unknown): number | null {
  for (const item of listOf(value)) {
    const number = Number(/\d+/.exec(plain(item))?.[0] ?? 0);
    if (number >= 1 && number <= 1_000_000) return number;
  }
  return null;
}

/** Steps from a string, a list, `HowToStep`s, or `HowToSection`s of them. */
function stepsOf(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return lines(value);
  if (Array.isArray(value)) return value.slice(0, MAX_LINES).flatMap((item) => stepsOf(item, depth + 1));
  if (!isObject(value)) return [];
  if (value.itemListElement !== undefined) return stepsOf(value.itemListElement, depth + 1);
  if (value.item !== undefined) return stepsOf(value.item, depth + 1);
  const text = plain(value.text) || plain(value.name);
  return text ? [text] : [];
}

function tagsOf(recipe: Json): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const values = [
    ...listOf(recipe.recipeCategory),
    ...listOf(recipe.recipeCuisine),
    ...listOf(recipe.keywords).flatMap((k) => (typeof k === "string" ? k.slice(0, 5000).split(",") : [])),
  ];
  for (const value of values) {
    const tag = plain(value);
    // A "tag" too long for the field is a sentence, not a tag.
    if (tag === "" || tag.length > 50 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/** The author's or publisher's name (which may be a reference elsewhere in the data), else the site. */
function creditOf(recipe: Json, nodes: Json[], pageUrl: string): string {
  for (const person of [...listOf(recipe.author), ...listOf(recipe.publisher)]) {
    let name = plain(isObject(person) ? person.name : person);
    if (!name && isObject(person) && typeof person["@id"] === "string") {
      const id = person["@id"];
      name = plain(nodes.find((node) => node["@id"] === id && node.name !== undefined)?.name);
    }
    if (name) return cut(name, 200);
  }
  return cut(new URL(pageUrl).hostname.replace(/^www\./, ""), 200);
}

export function readRecipePage(html: string, pageUrl: string, known: Known): ReadPage {
  const parsed = jsonLdBlocks(html).map((block) => ({ block, data: parseBlock(block) }));
  const nodes = nodesOf(parsed.map((p) => p.data));
  const recipes = nodes.filter(isRecipe);
  const recipe = recipes.find((node) => plain(node.name) !== "" && node.recipeIngredient !== undefined) ?? recipes.find((node) => plain(node.name) !== "");

  if (!recipe) {
    if (recipes.length > 0) return { ok: false, reason: "incomplete" };
    const broken = parsed.some((p) => p.data === undefined && /\bRecipe\b/.test(p.block));
    return { ok: false, reason: broken ? "broken" : "none" };
  }

  const parse = createIngredientParser(known);
  const ingredients = listOf(recipe.recipeIngredient ?? recipe.ingredients)
    .slice(0, MAX_LINES)
    .flatMap((item) => parse(plain(item)) ?? []);

  const prepAndCook = (minutesOf(recipe.prepTime) ?? 0) + (minutesOf(recipe.cookTime) ?? 0);
  const totalMinutes = minutesOf(recipe.totalTime) ?? (prepAndCook > 0 && prepAndCook <= 1_000_000 ? prepAndCook : null);

  const have = new Set(known.foods.map((food) => food.toLowerCase()));
  const newFoods = new Map<string, string>();
  for (const { food } of ingredients) {
    if (!have.has(food.toLowerCase()) && !newFoods.has(food.toLowerCase())) newFoods.set(food.toLowerCase(), food);
  }

  return {
    ok: true,
    newFoods: [...newFoods.values()],
    recipe: {
      name: cut(plain(recipe.name), 200),
      servings: servingsOf(recipe.recipeYield ?? recipe.yield),
      totalMinutes,
      sourceUrl: pageUrl.length <= 2000 ? pageUrl : null,
      sourceCredit: creditOf(recipe, nodes, pageUrl),
      tags: tagsOf(recipe),
      ingredients,
      steps: stepsOf(recipe.recipeInstructions)
        .map((step) => cut(step, 4000))
        .slice(0, MAX_LINES),
    },
  };
}
