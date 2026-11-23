import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mssql from "mssql";

/** The folder of numbered .sql files, next to src/ and dist/. */
export const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

/** Reads the migrations in a folder, in name order. */
export function listMigrations(dir: string = migrationsDir): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const text = readFileSync(`${dir}/${name}`, "utf8");
      // Hash with LF line endings, so a Windows checkout (CRLF) and CI (LF) agree.
      const checksum = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
      return { name, sql: text, checksum };
    });
}

/**
 * Applies the migrations that haven't run yet, in order, each in its own transaction.
 * Safe to run on every deploy and from two places at once: a database lock makes the
 * second runner wait, then find nothing left to do. A migration file that changed after
 * it was applied is an error, because the database no longer matches the code.
 */
export async function runMigrations(
  pool: mssql.ConnectionPool,
  dir: string = migrationsDir,
): Promise<{ applied: string[] }> {
  const migrations = listMigrations(dir);
  const applied: string[] = [];

  // A transaction-owned application lock, held on one connection for the whole run;
  // the migrations themselves run on other connections from the pool.
  const lock = new mssql.Transaction(pool);
  await lock.begin();
  try {
    await new mssql.Request(lock).input("name", "kitchen-migrations").query(`
      DECLARE @r INT;
      EXEC @r = sp_getapplock @Resource = @name, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 600000;
      IF @r < 0 THROW 50000, 'Could not get the migration lock', 1;`);

    await pool.request().batch(`
      IF OBJECT_ID('schema_migration', 'U') IS NULL
        CREATE TABLE schema_migration (
          name       NVARCHAR(200) NOT NULL CONSTRAINT pk_schema_migration PRIMARY KEY,
          checksum   CHAR(64)      NOT NULL,
          applied_at DATETIME2(0)  NOT NULL CONSTRAINT df_schema_migration_applied DEFAULT SYSUTCDATETIME()
        );`);

    const done = await pool.request().query("SELECT name, checksum FROM schema_migration");
    const history = new Map<string, string>(done.recordset.map((r) => [r.name, r.checksum]));

    // Check every applied file first, so a changed one stops the run before anything new runs.
    for (const m of migrations) {
      const known = history.get(m.name);
      if (known !== undefined && known !== m.checksum) {
        throw new Error(`Migration ${m.name} changed after it was applied. Add a new migration instead.`);
      }
    }

    for (const m of migrations) {
      if (history.has(m.name)) continue;
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        await new mssql.Request(tx).batch(`SET XACT_ABORT ON;\n${m.sql}`);
        await new mssql.Request(tx)
          .input("name", m.name)
          .input("checksum", m.checksum)
          .query("INSERT schema_migration (name, checksum) VALUES (@name, @checksum)");
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw new Error(`Migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      applied.push(m.name);
    }
  } finally {
    await lock.rollback().catch(() => undefined); // releases the lock
  }
  return { applied };
}
