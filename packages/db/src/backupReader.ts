import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type mssql from "mssql";
import { checkUserName, createEntraUserIfMissing, type EntraIdentity } from "./entraUser.js";

/** The grants, shared with infra/scripts/tests/export-database.integration.sh. */
const backupReaderGrantsFile = fileURLToPath(new URL("../sql/backup-reader.sql", import.meta.url));

/** The identity that runs the weekly export (card S2), such as kitchen-github-prod-backup. */
export type BackupReader = EntraIdentity;

const WHAT = "Backup reader";

/** Gives an existing database user read-only access to everything an export needs. */
export async function grantBackupReader(pool: mssql.ConnectionPool, name: string): Promise<void> {
  checkUserName(name, WHAT);
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
  await createEntraUserIfMissing(pool, reader, WHAT);
  await grantBackupReader(pool, reader.name);
}
