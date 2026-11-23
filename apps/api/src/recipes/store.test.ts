import { runMigrations } from "@kitchen/db";
import { createEmptyDatabase, testServer } from "@kitchen/db/test-database";
import type { RecipeInput } from "@kitchen/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SignedInUser } from "../auth.js";
import { createSqlRecipeStore, type RecipeStore } from "./store.js";

const toast: RecipeInput = {
  name: "Toast",
  servings: 1,
  totalMinutes: 5,
  sourceUrl: null,
  sourceCredit: null,
  tags: [],
  ingredients: [{ food: "Bread", quantity: 2, unit: "ea", note: null }],
  steps: ["Toast the bread."],
};

const user = (objectId: string, members: string[]): SignedInUser => ({
  objectId,
  name: undefined,
  household: { id: "home", memberObjectIds: members },
});

describe.skipIf(!testServer)("SQL recipe store households", () => {
  let store: RecipeStore;
  let drop: () => Promise<void>;
  const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const householdA1 = user(A1, [A1, A2]);
  const householdA2 = user(A2, [A1, A2]);
  const householdB = user(B1, [B1]);

  beforeAll(async () => {
    const database = await createEmptyDatabase();
    drop = database.drop;
    await runMigrations(database.pool);
    store = createSqlRecipeStore(database.pool);
  });
  afterAll(async () => {
    await drop();
  });

  it("shares recipes between members of one household", async () => {
    const made = await store.create(householdA1, toast);

    expect(await store.get(householdA2, made.id)).toEqual(made);
    expect((await store.list(householdA2)).map((r) => r.id)).toContain(made.id);
  });

  it("keeps another household's recipes out of sight and out of reach", async () => {
    const made = await store.create(householdA1, toast);

    expect(await store.list(householdB)).toEqual([]);
    expect(await store.get(householdB, made.id)).toBeNull();
    expect(await store.replace(householdB, made.id, { ...toast, name: "Stolen" })).toBeNull();
    expect(await store.remove(householdB, made.id)).toBe(false);
    expect((await store.get(householdA1, made.id))?.name).toBe("Toast");
  });
});
