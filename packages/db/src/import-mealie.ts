#!/usr/bin/env node
// One-time import from Mealie into the kitchen database (card K3). Run from the repo root:
//   pnpm --filter @kitchen/db import:mealie
// See "Importing from Mealie" in the README for the environment variables and the steps.
import { connectEntra } from "./connect.js";
import { createMealieClient, readMealie } from "./mealie/client.js";
import { formatReport, importMealie } from "./mealie/import.js";

const { SQL_SERVER: server, SQL_DATABASE: database, MEALIE_URL: baseUrl, MEALIE_TOKEN: token, KITCHEN_HOUSEHOLD_ID: householdEnv } = process.env;
if (!server || !database || !baseUrl || !token) {
  console.error("Set SQL_SERVER, SQL_DATABASE, MEALIE_URL and MEALIE_TOKEN. See \"Importing from Mealie\" in the README.");
  process.exit(1);
}

console.log(`Reading Mealie at ${baseUrl} (read-only)...`);
const data = await readMealie(createMealieClient({ baseUrl, token }));
console.log(`Read ${data.foods.length} foods, ${data.recipes.length} recipes and ${data.mealPlans.length} meal plan entries.`);

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
  const report = await importMealie(pool, household, data);
  console.log(`\n${formatReport(report)}`);
} finally {
  await pool.close();
}
