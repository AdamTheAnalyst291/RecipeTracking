import { randomUUID } from "node:crypto";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHousehold } from "./households.js";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("resolveHousehold", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
  });
  afterAll(async () => {
    await drop();
  });

  const count = async (table: string): Promise<number> =>
    (await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`)).recordset[0].n;

  it("creates the household and the user the first time someone signs in", async () => {
    const oid = randomUUID();

    const household = await resolveHousehold(pool, { objectId: oid, displayName: "Test User" });

    expect(await count("household")).toBe(1);
    const user = await pool.request().input("oid", oid).query("SELECT household_id, display_name FROM [user] WHERE entra_object_id = @oid");
    expect(user.recordset[0]).toMatchObject({ household_id: household, display_name: "Test User" });
  });

  it("gives the same household back on every later request", async () => {
    const oid = randomUUID();
    const first = await resolveHousehold(pool, { objectId: oid });
    const again = await resolveHousehold(pool, { objectId: oid.toUpperCase() });

    expect(again).toBe(first);
    expect(await count("[user]")).toBe(2);
  });

  it("puts a second member in the one existing household", async () => {
    const a = await resolveHousehold(pool, { objectId: randomUUID() });
    const b = await resolveHousehold(pool, { objectId: randomUUID() });

    expect(b).toBe(a);
    expect(await count("household")).toBe(1);
  });

  it("makes one household even when the first requests arrive together", async () => {
    const fresh = await createEmptyDatabase();
    try {
      await runMigrations(fresh.pool);
      const ids = await Promise.all(
        Array.from({ length: 6 }, () => resolveHousehold(fresh.pool, { objectId: randomUUID() })),
      );

      expect(new Set(ids).size).toBe(1);
      const n = await fresh.pool.request().query("SELECT COUNT(*) AS n FROM household");
      expect(n.recordset[0].n).toBe(1);
    } finally {
      await fresh.drop();
    }
  });
});
