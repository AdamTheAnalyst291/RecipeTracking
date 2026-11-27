#!/usr/bin/env node
// Loads the made-up sample transactions (test-fixtures/plaid-transactions.json) into a Dev
// database, through the same import Plaid will use (card $1), so the money screens can be
// tried before Plaid is connected (card $2). Run from the repo root:
//   pnpm --filter @kitchen/db import:sample-money
// See "Sample transactions in Dev" in the README. It refuses a Prod server.
import { readFileSync } from "node:fs";
import { connectEntra } from "./connect.js";
import { createMoney, type PlaidImport } from "./money.js";

const { SQL_SERVER: server, SQL_DATABASE: database, KITCHEN_HOUSEHOLD_ID: householdEnv } = process.env;
if (!server || !database) {
  console.error('Set SQL_SERVER and SQL_DATABASE. See "Sample transactions in Dev" in the README.');
  process.exit(1);
}
if (/prod/i.test(server) || /prod/i.test(database)) {
  console.error("This looks like Prod. Sample transactions are for Dev only.");
  process.exit(1);
}

const sample = JSON.parse(readFileSync(new URL("../test-fixtures/plaid-transactions.json", import.meta.url), "utf8")) as PlaidImport;

console.log(`Connecting to ${server} / ${database}...`);
const pool = await connectEntra({ server, database });
try {
  const households = (await pool.request().query("SELECT id FROM household ORDER BY created_at, id")).recordset.map((r) => String(r.id));
  const household = householdEnv ? households.find((h) => h.toLowerCase() === householdEnv.toLowerCase()) : households.length === 1 ? households[0] : undefined;
  if (!household) {
    console.error(
      households.length === 0
        ? "This database has no household yet. Sign in to the app once, then run this again."
        : `Set KITCHEN_HOUSEHOLD_ID to one of: ${households.join(", ")}`,
    );
    process.exit(1);
  }
  const report = await createMoney(pool).importPlaid(household, { accounts: sample.accounts, transactions: sample.transactions });
  console.log(
    `Added ${report.added}, updated ${report.updated}, skipped ${report.skippedPending} pending; ${report.categorizedByRule} categorized by rules.`,
  );
} finally {
  await pool.close();
}
