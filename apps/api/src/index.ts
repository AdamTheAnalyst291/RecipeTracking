import { app } from "@azure/functions";
import { syncBanks } from "./bank/sync.js";
import { errorText, functionLog } from "./bank/log.js";
import { bankServices } from "./bank/services.js";
import { banksForJobs, pantryForJobs, receiptRemindersForJobs } from "./database.js";
import { runPantrySnapshot } from "./functions/pantry.js";
import { RECEIPT_REMINDER_SCHEDULE, runReceiptReminder } from "./functions/receiptReminder.js";
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
const services = bankServices();
app.timer("bankSync", {
  schedule: "0 0 11 * * *",
  runOnStartup: false,
  handler: async (_timer, context) => {
    let stores: Awaited<ReturnType<typeof banksForJobs>>;
    try {
      stores = await banksForJobs();
    } catch (error) {
      // No database means no sync at all, which is worth a phone alert too.
      context.error(`Bank sync couldn't reach the database: ${errorText(error)}`);
      await services.alert("Kitchen bank sync failed", "Couldn't reach the database; nothing was synced.").catch((e: unknown) => context.error(`Bank sync couldn't send the phone alert: ${errorText(e)}`));
      throw error;
    }
    const summary = await syncBanks({
      ...stores,
      ...services,
      log: functionLog(context),
    });
    context.log(`Bank sync: ${summary.banks} bank(s), ${summary.failed} failed, ${summary.added} new, ${summary.updated} updated, ${summary.withdrawn} withdrawn`);
  },
});

// Sunday evening in US Central, one phone push to log receipts, through the same ntfy topic as
// the bank sync's alerts (card P5). Only for a week with a meal plan, and once per week.
app.timer("receiptReminder", {
  schedule: RECEIPT_REMINDER_SCHEDULE,
  runOnStartup: false,
  handler: async (_timer, context) => {
    await runReceiptReminder(await receiptRemindersForJobs(), services.alert, new Date(), context);
  },
});
