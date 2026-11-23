import { app } from "@azure/functions";
import { routes } from "./routes.js";

// Sign-in is checked in code (auth.ts), so the Functions host itself lets every request through.
for (const { name, route, methods, handler } of routes) {
  app.http(name, { methods, authLevel: "anonymous", route, handler });
}
