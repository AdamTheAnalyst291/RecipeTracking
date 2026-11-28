import { randomUUID } from "node:crypto";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";
import { ensureWarehouseBuilder, grantWarehouseBuilder } from "./warehouseBuilder.js";

describe.skipIf(!testServer)("warehouse builder", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  // SQL Server in a container has no Entra ID, so the tests stand in a user without a
  // login for the Entra one that ensureWarehouseBuilder creates in Azure SQL.
  const name = `warehouse_builder_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    await pool.request().batch(`CREATE USER [${name}] WITHOUT LOGIN`);
  });
  afterAll(async () => {
    await drop();
  });

  const can = async (sqlText: string): Promise<boolean> => {
    try {
      await pool.request().batch(`EXECUTE AS USER = '${name}'; ${sqlText}; REVERT;`);
      return true;
    } catch {
      await pool.request().batch("REVERT;").catch(() => undefined);
      return false;
    }
  };

  it("can read the app's tables once granted", async () => {
    expect(await can("SELECT TOP 1 * FROM dbo.household")).toBe(false);

    await grantWarehouseBuilder(pool, name);

    expect(await can("SELECT TOP 1 * FROM dbo.household")).toBe(true);
    expect(await can("SELECT TOP 1 * FROM dbo.pantry_snapshot")).toBe(true);
  });

  it("owns the marts schema, so it can build, rebuild and drop tables and views there", async () => {
    await grantWarehouseBuilder(pool, name);
    const owner = await pool.request().query("SELECT USER_NAME(principal_id) AS owner FROM sys.schemas WHERE name = 'marts'");
    expect(owner.recordset[0]?.owner).toBe(name);

    expect(await can("CREATE TABLE marts.t (id INT); INSERT marts.t VALUES (1); UPDATE marts.t SET id = 2; DELETE FROM marts.t")).toBe(true);
    expect(await can("EXEC sp_rename 'marts.t', 't_old'; DROP TABLE marts.t_old")).toBe(true);
    expect(await can("EXEC('CREATE VIEW marts.v AS SELECT id, name FROM dbo.household')")).toBe(true);
    expect(await can("SELECT * FROM marts.v")).toBe(true);
    expect(await can("DROP VIEW marts.v")).toBe(true);
  });

  it("can't write, create or change anything outside marts", async () => {
    await grantWarehouseBuilder(pool, name);
    expect(await can("INSERT dbo.household (name) VALUES (N'Intruder')")).toBe(false);
    expect(await can("UPDATE dbo.household SET name = N'Intruder'")).toBe(false);
    expect(await can("DELETE FROM dbo.schema_migration")).toBe(false);
    expect(await can("CREATE TABLE dbo.intruder (id INT)")).toBe(false);
    expect(await can("EXEC('CREATE VIEW dbo.intruder AS SELECT 1 AS x')")).toBe(false);
    expect(await can("ALTER TABLE dbo.household ADD intruder INT NULL")).toBe(false);
    expect(await can("CREATE SCHEMA intruder")).toBe(false);
    expect(await can("EXEC('CREATE PROCEDURE marts.p AS SELECT 1')")).toBe(false);
  });

  it("can't reach the app's tables for writing through a view in marts", async () => {
    // A view in a schema owned by dbo would chain ownership to dbo's tables. marts is owned
    // by the builder, so an insert through its view is checked against dbo and refused.
    await grantWarehouseBuilder(pool, name);
    expect(await can("EXEC('CREATE VIEW marts.household_rw AS SELECT id, name FROM dbo.household')")).toBe(true);
    expect(await can("INSERT marts.household_rw (name) VALUES (N'Intruder')")).toBe(false);
    await pool.request().batch("DROP VIEW marts.household_rw");
  });

  it("is safe to run again", async () => {
    await grantWarehouseBuilder(pool, name);
    await grantWarehouseBuilder(pool, name);
  });

  it("leaves an existing user alone instead of creating it again", async () => {
    await ensureWarehouseBuilder(pool, { name, clientId: randomUUID() });
    expect(await can("SELECT TOP 1 * FROM dbo.household")).toBe(true);
  });

  it("refuses names that could break out of the brackets", async () => {
    await expect(grantWarehouseBuilder(pool, "x]; DROP TABLE household; --")).rejects.toThrow(/name/);
    await expect(ensureWarehouseBuilder(pool, { name: "x]", clientId: randomUUID() })).rejects.toThrow(/name/);
  });

  it("refuses a client ID that isn't a GUID", async () => {
    await expect(ensureWarehouseBuilder(pool, { name, clientId: "kitchen-github-dev-warehouse" })).rejects.toThrow(/client ID/);
  });
});
