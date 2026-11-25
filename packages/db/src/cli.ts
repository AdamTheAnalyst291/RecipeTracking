#!/usr/bin/env node
// Applies the migrations. Used by the Deploy Dev and Deploy Prod workflows:
//   SQL_SERVER=<server>.database.windows.net SQL_DATABASE=sqldb-kitchen-app node dist/cli.js
// With BACKUP_READER_NAME and BACKUP_READER_CLIENT_ID set (Deploy Prod), it then makes the
// weekly export's identity a read-only database user (card S2).
import { ensureBackupReader } from "./backupReader.js";
import { connectEntra } from "./connect.js";
import { runMigrations } from "./migrate.js";

const server = process.env.SQL_SERVER;
const database = process.env.SQL_DATABASE;
if (!server || !database) {
  console.error("Set SQL_SERVER and SQL_DATABASE.");
  process.exit(1);
}

const pool = await connectEntra({ server, database });
try {
  const { applied } = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");

  const readerName = process.env.BACKUP_READER_NAME;
  const readerClientId = process.env.BACKUP_READER_CLIENT_ID;
  if (readerName && readerClientId) {
    await ensureBackupReader(pool, { name: readerName, clientId: readerClientId });
    console.log(`${readerName} can read the database for the weekly export.`);
  } else if (readerName) {
    // The backup identity doesn't exist until the bootstrap is applied again (infra/README.md, "Backups").
    console.log(`No client ID for ${readerName} yet, so the weekly export can't read the database.`);
  }
} finally {
  await pool.close();
}
