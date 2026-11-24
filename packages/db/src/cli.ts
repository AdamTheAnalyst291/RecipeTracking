#!/usr/bin/env node
// Applies the migrations. Used by the Deploy Dev and Deploy Prod workflows:
//   SQL_SERVER=<server>.database.windows.net SQL_DATABASE=sqldb-kitchen-app node dist/cli.js
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
} finally {
  await pool.close();
}
