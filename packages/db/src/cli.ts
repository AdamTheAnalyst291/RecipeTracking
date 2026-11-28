#!/usr/bin/env node
// Applies the migrations. Used by the Deploy Dev and Deploy Prod workflows:
//   SQL_SERVER=<server>.database.windows.net SQL_DATABASE=sqldb-kitchen-app node dist/cli.js
// With API_USER_NAME and API_USER_CLIENT_ID set (both deploy workflows), it then makes the
// API's managed identity a database user that can read and write the data. With
// BACKUP_READER_NAME and BACKUP_READER_CLIENT_ID set (Deploy Prod), it makes the weekly
// export's identity a read-only database user (card S2). With WAREHOUSE_BUILDER_NAME and
// WAREHOUSE_BUILDER_CLIENT_ID set (Deploy Dev), it makes the nightly dbt build's identity a
// user that reads the app's tables and builds only the marts schema (card W1).
import { ensureApiUser } from "./apiUser.js";
import { ensureBackupReader } from "./backupReader.js";
import { connectEntra } from "./connect.js";
import { runMigrations } from "./migrate.js";
import { ensureWarehouseBuilder } from "./warehouseBuilder.js";

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

  // Without this user the API can't sign in to the database, so every screen that reads
  // data answers 503. Half a setting is a broken deploy, not something to skip quietly.
  const apiName = process.env.API_USER_NAME;
  const apiClientId = process.env.API_USER_CLIENT_ID;
  if (apiName || apiClientId) {
    if (!apiName || !apiClientId) throw new Error("Set both API_USER_NAME and API_USER_CLIENT_ID, or neither.");
    await ensureApiUser(pool, { name: apiName, clientId: apiClientId });
    console.log(`${apiName} can read and write the data.`);
  }

  const readerName = process.env.BACKUP_READER_NAME;
  const readerClientId = process.env.BACKUP_READER_CLIENT_ID;
  if (readerName && readerClientId) {
    await ensureBackupReader(pool, { name: readerName, clientId: readerClientId });
    console.log(`${readerName} can read the database for the weekly export.`);
  } else if (readerName) {
    // The backup identity doesn't exist until the bootstrap is applied again (infra/README.md, "Backups").
    console.log(`No client ID for ${readerName} yet, so the weekly export can't read the database.`);
  }

  const builderName = process.env.WAREHOUSE_BUILDER_NAME;
  const builderClientId = process.env.WAREHOUSE_BUILDER_CLIENT_ID;
  if (builderName && builderClientId) {
    await ensureWarehouseBuilder(pool, { name: builderName, clientId: builderClientId });
    console.log(`${builderName} can read the app's tables and build marts.`);
  } else if (builderName) {
    // The warehouse identity doesn't exist until the bootstrap is applied again (infra/README.md, "Warehouse").
    console.log(`No client ID for ${builderName} yet, so the nightly dbt build can't sign in to the database.`);
  }
} finally {
  await pool.close();
}
