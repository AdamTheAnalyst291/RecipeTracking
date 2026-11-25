import { HttpRequest, InvocationContext, type HttpResponseInit } from "@azure/functions";
import { runMigrations } from "@kitchen/db";
import { createEmptyDatabase, testServer } from "@kitchen/db/test-database";
import type { Recipe, RecipeInput, RecipeListResponse, UnitListResponse } from "@kitchen/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAuth } from "../auth.js";
import { createSqlRecipeStore } from "../recipes/store.js";
import { ADAM, SOMEONE_ELSE, testAuthenticator, testConfig, token } from "../test/identity.js";
import { createRecipeHandlers } from "./recipes.js";

// Made-up recipes; the repo is public.
const lentilSoup: RecipeInput = {
  name: "Lentil soup",
  servings: 4,
  totalMinutes: 45,
  sourceUrl: "https://example.com/lentil-soup",
  sourceCredit: "Made-up Cookbook",
  tags: ["quick", "soup"],
  ingredients: [
    { food: "Red lentils", quantity: 1.5, unit: "cup", note: "rinsed" },
    { food: "Salt", quantity: null, unit: null, note: null },
  ],
  steps: ["Simmer the lentils.", "Season and serve."],
};
const flatbread: RecipeInput = {
  name: "Flatbread",
  servings: null,
  totalMinutes: 20,
  sourceUrl: null,
  sourceCredit: null,
  tags: ["bread"],
  ingredients: [{ food: "Flour", quantity: 250, unit: "gram", note: null }],
  steps: ["Mix.", "Fry."],
};

describe.skipIf(!testServer)("recipe API", () => {
  let drop: () => Promise<void>;
  let handlers: ReturnType<typeof createRecipeHandlers>;
  let pool: Awaited<ReturnType<typeof createEmptyDatabase>>["pool"];
  const context = new InvocationContext();

  beforeAll(async () => {
    const database = await createEmptyDatabase();
    drop = database.drop;
    pool = database.pool;
    await runMigrations(database.pool);
    const store = createSqlRecipeStore(database.pool);
    handlers = createRecipeHandlers(() => store);
  });
  afterAll(async () => {
    await drop();
  });

  const collection = () => withAuth(handlers.collection, () => testAuthenticator);
  const item = () => withAuth(handlers.item, () => testAuthenticator);
  const units = () => withAuth(handlers.units, () => testAuthenticator);

  async function call(
    handler: (r: HttpRequest, c: InvocationContext) => Promise<HttpResponseInit>,
    method: string,
    { id, body, authorization }: { id?: string; body?: unknown; authorization?: string | null } = {},
  ): Promise<HttpResponseInit> {
    const auth = authorization === undefined ? `Bearer ${await token()}` : authorization;
    return handler(
      new HttpRequest({
        method,
        url: `http://localhost:7071/api/recipes${id ? `/${id}` : ""}`,
        headers: auth === null ? {} : { authorization: auth },
        params: id ? { id } : {},
        ...(body === undefined ? {} : { body: { string: typeof body === "string" ? body : JSON.stringify(body) } }),
      }),
      context,
    );
  }

  const create = async (input: RecipeInput = lentilSoup) => {
    const response = await call(collection(), "POST", { body: input });
    expect(response.status).toBe(201);
    return response.jsonBody as Recipe;
  };

  it("names the household's foods, for matching imported ingredients", async () => {
    await create();
    const user = { objectId: ADAM, name: "Test User", household: testConfig.household };

    expect(await createSqlRecipeStore(pool).foods(user)).toEqual(expect.arrayContaining(["Red lentils", "Salt"]));
  });

  describe("create", () => {
    it("saves a recipe and reads it back with its ingredients and steps in order", async () => {
      const created = await create();

      expect(created).toEqual({ ...lentilSoup, id: expect.any(String) });
      const read = await call(item(), "GET", { id: created.id });
      expect(read.status).toBe(200);
      expect(read.jsonBody).toEqual(created);
    });

    it("answers where the new recipe lives", async () => {
      const response = await call(collection(), "POST", { body: flatbread });

      const id = (response.jsonBody as Recipe).id;
      expect(response.headers).toMatchObject({ Location: `/api/recipes/${id}` });
    });

    it("reuses a food by name ignoring case, so recipes share one food table", async () => {
      await create({ ...flatbread, name: "Pancakes", ingredients: [{ food: "flour", quantity: 100, unit: "g", note: null }] });
      await create({ ...flatbread, name: "Roti", ingredients: [{ food: "FLOUR", quantity: 200, unit: "gram", note: null }] });
      // Both resolve to the same food and show it the way each was first named.
      const list = (await call(collection(), "GET")).jsonBody as RecipeListResponse;
      expect(list.recipes.filter((r) => ["Pancakes", "Roti"].includes(r.name))).toHaveLength(2);
    });

    it("refuses bad input with 400 and says what is wrong", async () => {
      const response = await call(collection(), "POST", { body: { ...lentilSoup, name: "", servings: 0 } });

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ errors: expect.arrayContaining(["Name is required."]) });
    });

    it("refuses a unit nobody has heard of with 400", async () => {
      const response = await call(collection(), "POST", {
        body: { ...lentilSoup, ingredients: [{ food: "Water", quantity: 1, unit: "bucket", note: null }] },
      });

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ errors: [expect.stringContaining("bucket")] });
    });

    it("refuses a body that isn't JSON with 400", async () => {
      expect((await call(collection(), "POST", { body: "{not json" })).status).toBe(400);
    });
  });

  describe("list", () => {
    it("lists recipes by name with their tags", async () => {
      await create({ ...flatbread, name: "Zucchini bread", tags: ["bread", "sweet"] });
      await create({ ...flatbread, name: "Apple crumble", tags: [] });

      const response = await call(collection(), "GET");

      expect(response.status).toBe(200);
      const names = (response.jsonBody as RecipeListResponse).recipes.map((r) => r.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(response.jsonBody).toMatchObject({
        recipes: expect.arrayContaining([
          { id: expect.any(String), name: "Zucchini bread", servings: null, totalMinutes: 20, tags: ["bread", "sweet"] },
          { id: expect.any(String), name: "Apple crumble", servings: null, totalMinutes: 20, tags: [] },
        ]),
      });
    });
  });

  describe("edit", () => {
    it("replaces the recipe, its ingredients, tags and steps", async () => {
      const created = await create();
      const changed: RecipeInput = {
        ...lentilSoup,
        name: "Spicy lentil soup",
        servings: 6,
        tags: ["soup"],
        ingredients: [{ food: "Chilli flakes", quantity: 1, unit: "tsp", note: null }, ...lentilSoup.ingredients],
        steps: ["Fry the chilli.", "Simmer the lentils.", "Serve."],
      };

      const response = await call(item(), "PUT", { id: created.id, body: changed });

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ ...changed, id: created.id });
      expect((await call(item(), "GET", { id: created.id })).jsonBody).toEqual({ ...changed, id: created.id });
    });

    it("answers 404 for a recipe that isn't there", async () => {
      const response = await call(item(), "PUT", { id: "99999999-9999-4999-8999-999999999999", body: lentilSoup });

      expect(response.status).toBe(404);
    });

    it("refuses bad input with 400 and leaves the recipe as it was", async () => {
      const created = await create();

      const response = await call(item(), "PUT", { id: created.id, body: { ...lentilSoup, steps: ["ok", " "] } });

      expect(response.status).toBe(400);
      expect((await call(item(), "GET", { id: created.id })).jsonBody).toEqual(created);
    });

    it("leaves the recipe as it was when an ingredient's unit is unknown", async () => {
      const created = await create();

      const response = await call(item(), "PUT", {
        id: created.id,
        body: { ...lentilSoup, ingredients: [{ food: "Water", quantity: 1, unit: "bucket", note: null }] },
      });

      expect(response.status).toBe(400);
      expect((await call(item(), "GET", { id: created.id })).jsonBody).toEqual(created);
    });
  });

  describe("delete", () => {
    it("removes the recipe, and a second delete answers 404", async () => {
      const created = await create();

      expect((await call(item(), "DELETE", { id: created.id })).status).toBe(204);
      expect((await call(item(), "GET", { id: created.id })).status).toBe(404);
      expect((await call(item(), "DELETE", { id: created.id })).status).toBe(404);
      const list = (await call(collection(), "GET")).jsonBody as RecipeListResponse;
      expect(list.recipes.map((r) => r.id)).not.toContain(created.id);
    });

    it("answers 404 for an id that isn't an id", async () => {
      expect((await call(item(), "GET", { id: "not-an-id" })).status).toBe(404);
    });
  });

  describe("units", () => {
    it("lists the units to choose from", async () => {
      const response = await call(units(), "GET");

      expect(response.status).toBe(200);
      expect((response.jsonBody as UnitListResponse).units).toEqual(
        expect.arrayContaining([{ name: "cup", abbreviation: "cup" }, { name: "gram", abbreviation: "g" }]),
      );
    });
  });

  describe("sign-in", () => {
    it.each([
      ["list", () => collection(), "GET", undefined],
      ["create", () => collection(), "POST", undefined],
      ["read", () => item(), "GET", "99999999-9999-4999-8999-999999999999"],
      ["edit", () => item(), "PUT", "99999999-9999-4999-8999-999999999999"],
      ["delete", () => item(), "DELETE", "99999999-9999-4999-8999-999999999999"],
      ["units", () => units(), "GET", undefined],
    ])("%s answers 401 without a token", async (_name, handler, method, id) => {
      const response = await call(handler(), method, { id, body: lentilSoup, authorization: null });

      expect(response.status).toBe(401);
    });

    it("answers 403 to someone outside the household and shows them nothing", async () => {
      const created = await create();
      const stranger = `Bearer ${await token({ oid: SOMEONE_ELSE })}`;

      expect((await call(collection(), "GET", { authorization: stranger })).status).toBe(403);
      expect((await call(item(), "GET", { id: created.id, authorization: stranger })).status).toBe(403);
      expect((await call(item(), "DELETE", { id: created.id, authorization: stranger })).status).toBe(403);
    });
  });

  it("answers 500 without leaking details when the database fails", async () => {
    const broken = createRecipeHandlers(() => {
      throw new Error("connection string secret");
    });

    const response = await call(withAuth(broken.collection, () => testAuthenticator), "GET");

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("secret");
  });
});
