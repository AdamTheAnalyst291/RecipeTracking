import { app } from "@azure/functions";
import { pantryForJobs } from "./database.js";
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
