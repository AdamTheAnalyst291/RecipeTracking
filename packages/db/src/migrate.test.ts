import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations, runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("runMigrations", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  const names = listMigrations().map((m) => m.name);

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
  });
  afterAll(async () => {
    await drop();
  });

  it("has migrations, numbered in order", () => {
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toMatch(/^0001_/);
  });

  it("applies every migration to an empty database", async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toEqual(names);
    const tables = await pool.request().query(
      "SELECT name FROM sys.tables WHERE name <> 'schema_migration' ORDER BY name",
    );
    expect(tables.recordset.map((r) => r.name)).toEqual(
      expect.arrayContaining(["household", "user", "food", "unit", "unit_conversion", "shopping_list", "shopping_list_item", "money_account", "money_category", "money_transaction", "money_split", "money_rule", "plaid_item", "plaid_item_account", "plaid_withdrawn"]),
    );
  });

  it("is idempotent: a second run applies nothing", async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
    const rows = await pool.request().query("SELECT COUNT(*) AS n FROM schema_migration");
    expect(rows.recordset[0].n).toBe(names.length);
  });

  it("refuses a migration whose file changed after it was applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const first = names[0] as string;
    writeFileSync(join(dir, first), "SELECT 1;");
    await expect(runMigrations(pool, dir)).rejects.toThrow(/changed/i);
  });

  it("lets two runners start together: one applies, the other finds nothing to do", async () => {
    const { pool: other, drop: dropOther } = await createEmptyDatabase();
    try {
      const [a, b] = await Promise.all([runMigrations(other), runMigrations(other)]);
      expect([...a.applied, ...b.applied]).toEqual(names);
    } finally {
      await dropOther();
    }
  });

  it("rolls back a failing migration and applies nothing after it", async () => {
    const { pool: other, drop: dropOther } = await createEmptyDatabase();
    try {
      const dir = mkdtempSync(join(tmpdir(), "mig-"));
      writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ok_table (id INT);");
      writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE half (id INT); SELECT 1/0;");
      writeFileSync(join(dir, "0003_never.sql"), "CREATE TABLE never (id INT);");
      await expect(runMigrations(other, dir)).rejects.toThrow();
      const tables = await other.request().query("SELECT name FROM sys.tables ORDER BY name");
      expect(tables.recordset.map((r) => r.name)).toEqual(["ok_table", "schema_migration"]);
    } finally {
      await dropOther();
    }
  });
});
