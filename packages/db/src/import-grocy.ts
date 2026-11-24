#!/usr/bin/env node
// One-time import from Grocy into the kitchen database (card K5). Run from the repo root:
//   pnpm --filter @kitchen/db import:grocy
// See "Importing from Grocy" in the README for the environment variables and the steps.
import { connectEntra } from "./connect.js";
import { createGrocyClient, readGrocy } from "./grocy/client.js";
import { formatReport, importGrocy } from "./grocy/import.js";

const { SQL_SERVER: server, SQL_DATABASE: database, GROCY_URL: baseUrl, GROCY_API_KEY: apiKey, KITCHEN_HOUSEHOLD_ID: householdEnv } = process.env;
if (!server || !database || !baseUrl || !apiKey) {
  console.error("Set SQL_SERVER, SQL_DATABASE, GROCY_URL and GROCY_API_KEY. See \"Importing from Grocy\" in the README.");
  process.exit(1);
}

console.log(`Reading Grocy at ${baseUrl} (read-only)...`);
const data = await readGrocy(createGrocyClient({ baseUrl, apiKey }));
console.log(`Read ${data.products.length} products and ${data.stock.length} stock rows.`);

console.log(`Connecting to ${server} / ${database}...`);
const pool = await connectEntra({ server, database });
try {
  const households = (await pool.request().query("SELECT id FROM household ORDER BY created_at, id")).recordset.map((r) => String(r.id));
  let household: string | undefined;
  if (householdEnv) household = households.find((id) => id.toLowerCase() === householdEnv.toLowerCase());
  else if (households.length === 1) household = households[0];
  if (!household) {
    console.error(
      householdEnv
        ? `No household ${householdEnv} in this database.`
        : households.length === 0
          ? "This database has no household yet. Sign in to the app once, then run the import again."
          : `This database has ${households.length} households; set KITCHEN_HOUSEHOLD_ID to one of: ${households.join(", ")}`,
    );
    process.exit(1);
  }
  const report = await importGrocy(pool, household, data);
  console.log(`\n${formatReport(report)}`);
} finally {
  await pool.close();
}
