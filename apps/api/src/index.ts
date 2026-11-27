import { app } from "@azure/functions";
import { syncBanks } from "./bank/sync.js";
import { bankServices } from "./bank/services.js";
import { banksForJobs, pantryForJobs } from "./database.js";
import { runPantrySnapshot } from "./functions/pantry.js";
import { routes } from "./routes.js";

// Sign-in is checked in code (auth.ts), so the Functions host itself lets every request through.
for (const { name, route, methods, handler } of routes) {
  app.http(name, { methods, authLevel: "anonymous", route, handler });
}

// Every day at 00:05 UTC, write each pantry product's stock and price to the snapshot table.
// Those values change and a missed day can't be rebuilt (ADR-28). Running again the same day
// overwrites that day's rows, so a retry is safe.
app.timer("pantrySnapshot", {
  schedule: "0 5 0 * * *",
  runOnStartup: false,
  handler: async (_timer, context) => {
    await runPantrySnapshot(await pantryForJobs(), new Date(), context);
  },
});

// Every day at 11:00 UTC (early morning in the US), sync each connected bank through Plaid's
// /transactions/sync (card $2, ADR-27). A failure is saved on the bank and sends one phone
// alert through ntfy; the cursor only moves after a bank's rows are saved, so the next run
// picks up whatever this one missed. Running it again is safe: Plaid's ids prevent duplicates.
const banks = bankServices();
app.timer("bankSync", {
  schedule: "0 0 11 * * *",
  runOnStartup: false,
  handler: async (_timer, context) => {
    let stores: Awaited<ReturnType<typeof banksForJobs>>;
    try {
      stores = await banksForJobs();
    } catch (error) {
      // No database means no sync at all, which is worth a phone alert too.
      context.error(`Bank sync couldn't reach the database: ${error instanceof Error ? error.message : String(error)}`);
      await banks.alert("Kitchen bank sync failed", "Couldn't reach the database; nothing was synced.").catch((e: unknown) => context.error(`Bank sync couldn't send the phone alert: ${String(e)}`));
      throw error;
    }
    const summary = await syncBanks({
      ...stores,
      ...banks,
      log: { info: (m) => context.log(m), error: (m, e) => context.error(e === undefined ? m : `${m}: ${String(e)}`) },
    });
    context.log(`Bank sync: ${summary.banks} bank(s), ${summary.failed} failed, ${summary.added} new, ${summary.updated} updated, ${summary.withdrawn} withdrawn`);
  },
});
