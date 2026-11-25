import { randomUUID } from "node:crypto";
import type sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBackupReader, grantBackupReader } from "./backupReader.js";
import { runMigrations } from "./migrate.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

describe.skipIf(!testServer)("backup reader", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  // SQL Server in a container has no Entra ID, so the tests stand in a user without a
  // login for the Entra one that ensureBackupReader creates in Azure SQL.
  const name = `backup_reader_${randomUUID().slice(0, 8)}`;

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

  it("can read every table and every definition once granted", async () => {
    expect(await can("SELECT TOP 1 * FROM household")).toBe(false);

    await grantBackupReader(pool, name);

    expect(await can("SELECT TOP 1 * FROM household")).toBe(true);
    expect(await can("SELECT TOP 1 * FROM schema_migration")).toBe(true);
    const perms = await pool
      .request()
      .input("name", name)
      .query("SELECT IS_ROLEMEMBER('db_datareader', @name) AS reader, (SELECT COUNT(*) FROM sys.database_permissions WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(@name) AND permission_name = 'VIEW DEFINITION' AND state = 'G') AS view_definition");
    expect(perms.recordset[0]).toEqual({ reader: 1, view_definition: 1 });
  });

  it("can't write or change anything", async () => {
    await grantBackupReader(pool, name);
    expect(await can("INSERT household (name) VALUES (N'Intruder')")).toBe(false);
    expect(await can("DELETE FROM schema_migration")).toBe(false);
    expect(await can("CREATE TABLE intruder (id INT)")).toBe(false);
  });

  it("is safe to run again", async () => {
    await grantBackupReader(pool, name);
    await grantBackupReader(pool, name);
  });

  it("leaves an existing user alone instead of creating it again", async () => {
    await ensureBackupReader(pool, { name, clientId: randomUUID() });
    expect(await can("SELECT TOP 1 * FROM household")).toBe(true);
  });

  it("refuses names that could break out of the brackets", async () => {
    await expect(grantBackupReader(pool, "x]; DROP TABLE household; --")).rejects.toThrow(/name/);
    await expect(ensureBackupReader(pool, { name: "x]", clientId: randomUUID() })).rejects.toThrow(/name/);
  });

  it("refuses a client ID that isn't a GUID", async () => {
    await expect(ensureBackupReader(pool, { name, clientId: "kitchen-github-prod-backup" })).rejects.toThrow(/client ID/);
  });
});
