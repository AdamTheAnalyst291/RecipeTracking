import { randomUUID } from "node:crypto";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("base model", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
  });
  afterAll(async () => {
    await drop();
  });

  async function newHousehold(name = "Test household"): Promise<string> {
    const r = await pool.request().input("name", name).query(
      "INSERT household (name) OUTPUT inserted.id VALUES (@name)",
    );
    return r.recordset[0].id;
  }

  it("ties a user to a household and to one Entra object id", async () => {
    const household = await newHousehold();
    const oid = randomUUID();
    const insert = () =>
      pool.request().input("h", household).input("oid", oid).input("n", "Test User").query(
        "INSERT [user] (household_id, entra_object_id, display_name) VALUES (@h, @oid, @n)",
      );
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|duplicate/i);
  });

  it("rejects a user in a household that does not exist", async () => {
    await expect(
      pool.request().input("h", randomUUID()).input("oid", randomUUID()).query(
        "INSERT [user] (household_id, entra_object_id) VALUES (@h, @oid)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("keeps one food per name per household, ignoring case", async () => {
    const a = await newHousehold("A");
    const b = await newHousehold("B");
    const add = (h: string, name: string) =>
      pool.request().input("h", h).input("n", name).query(
        "INSERT food (household_id, name) VALUES (@h, @n)",
      );
    await add(a, "Flour");
    await expect(add(a, "flour")).rejects.toThrow(/UNIQUE|duplicate/i);
    await add(b, "Flour");
  });

  it("seeds the standard units with conversions", async () => {
    const r = await pool.request().query(`
      SELECT c.factor FROM unit_conversion c
      JOIN unit f ON f.id = c.from_unit_id AND f.abbreviation = 'kg'
      JOIN unit t ON t.id = c.to_unit_id AND t.abbreviation = 'g'`);
    expect(Number(r.recordset[0].factor)).toBe(1000);
  });

  it("only converts within one kind of unit", async () => {
    const r = await pool.request().query(`
      SELECT COUNT(*) AS n FROM unit_conversion c
      JOIN unit f ON f.id = c.from_unit_id JOIN unit t ON t.id = c.to_unit_id
      WHERE f.kind <> t.kind`);
    expect(r.recordset[0].n).toBe(0);
    await expect(
      pool.request().query(`
        INSERT unit_conversion (from_unit_id, to_unit_id, kind, factor)
        SELECT f.id, t.id, 'mass', 1 FROM unit f, unit t WHERE f.abbreviation = 'g' AND t.abbreviation = 'ml'`),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects a conversion with a factor of zero or less", async () => {
    await pool.request().query(
      "INSERT unit (name, abbreviation, kind) VALUES ('pinch', 'pinch', 'volume'), ('dash', 'dash', 'volume')",
    );
    await expect(
      pool.request().query(`
        INSERT unit_conversion (from_unit_id, to_unit_id, kind, factor)
        SELECT f.id, t.id, 'volume', 0 FROM unit f, unit t WHERE f.abbreviation = 'pinch' AND t.abbreviation = 'dash'`),
    ).rejects.toThrow(/CHECK/i);
  });
});
