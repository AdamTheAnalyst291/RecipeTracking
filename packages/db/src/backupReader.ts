import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mssql from "mssql";

/** The grants, shared with infra/scripts/tests/export-database.integration.sh. */
const backupReaderGrantsFile = fileURLToPath(new URL("../sql/backup-reader.sql", import.meta.url));

/** The identity that runs the weekly export (card S2), such as kitchen-github-prod-backup. */
export interface BackupReader {
  /** Database user name; letters, digits, `_` and `-` only, so it's safe inside brackets. */
  name: string;
  /** The identity's application (client) ID, which is an Entra service principal's SID. */
  clientId: string;
}

const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Backup reader name must be letters, digits, _ and - only: ${name}`);
}

/** Gives an existing database user read-only access to everything an export needs. */
export async function grantBackupReader(pool: mssql.ConnectionPool, name: string): Promise<void> {
  checkName(name);
  const grants = readFileSync(backupReaderGrantsFile, "utf8").replaceAll("$(BACKUP_READER)", name);
  await pool.request().batch(grants);
}

/**
 * Makes the backup identity a read-only user of this database, creating it from its
 * client ID if it isn't there yet. Run as the database's Entra admin (the Deploy Prod
 * workflow, after the migrations). Creating by SID needs no Microsoft Graph lookup, so the
 * SQL server needs no directory permissions. Safe to run on every deploy.
 */
export async function ensureBackupReader(pool: mssql.ConnectionPool, reader: BackupReader): Promise<void> {
  checkName(reader.name);
  if (!GUID.test(reader.clientId)) throw new Error(`Backup reader client ID must be a GUID: ${reader.clientId}`);
  await pool
    .request()
    .input("name", reader.name)
    .input("clientId", reader.clientId)
    .query(`
      IF DATABASE_PRINCIPAL_ID(@name) IS NULL
      BEGIN
        DECLARE @sid NVARCHAR(40) = CONVERT(NVARCHAR(40), CONVERT(VARBINARY(16), CAST(@clientId AS UNIQUEIDENTIFIER)), 1);
        DECLARE @create NVARCHAR(400) = N'CREATE USER ' + QUOTENAME(@name) + N' WITH SID = ' + @sid + N', TYPE = E';
        EXEC (@create);
      END`);
  await grantBackupReader(pool, reader.name);
}
