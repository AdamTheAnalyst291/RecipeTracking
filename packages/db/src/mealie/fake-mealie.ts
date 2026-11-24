import { readFileSync } from "node:fs";

export interface MealieFixture {
  foods: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  mealPlans: Record<string, unknown>[];
}

/** The made-up export the tests use (never real recipes). */
export function loadFixture(): MealieFixture {
  return JSON.parse(readFileSync(new URL("../../test-fixtures/mealie-export.json", import.meta.url), "utf8")) as MealieFixture;
}

export interface RecordedRequest {
  method: string | undefined;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for Mealie's REST API, serving the fixture and recording every request it gets. Tests only. */
export function fakeMealie(options: { oldMealPlanPath?: boolean; fixture?: MealieFixture } = {}) {
  const data = options.fixture ?? loadFixture();
  const requests: RecordedRequest[] = [];
  const page = (items: unknown[], url: URL) => {
    const perPage = Number(url.searchParams.get("perPage") ?? 50);
    const p = Number(url.searchParams.get("page") ?? 1);
    return {
      page: p,
      per_page: perPage,
      total: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / perPage)),
      items: items.slice((p - 1) * perPage, p * perPage),
    };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method, url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (init?.method !== "GET") return json({ detail: "read-only in tests" }, 405);
    if (url.pathname === "/api/foods") return json(page(data.foods, url));
    if (url.pathname === "/api/recipes") {
      return json(page(data.recipes.map(({ id, slug, name }) => ({ id, slug, name: name ?? slug })), url));
    }
    const detail = /^\/api\/recipes\/(.+)$/.exec(url.pathname);
    if (detail) {
      const recipe = data.recipes.find((r) => r.slug === decodeURIComponent(detail[1] ?? ""));
      return !recipe || recipe.broken ? json({ detail: "boom" }, 500) : json(recipe);
    }
    const planPath = options.oldMealPlanPath ? "/api/groups/mealplans" : "/api/households/mealplans";
    if (url.pathname === planPath) return json(page(data.mealPlans, url));
    return json({ detail: "not found" }, 404);
  }) as typeof fetch;

  return { fetch: fetchFake, requests };
}
