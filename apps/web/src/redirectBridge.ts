import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

// The whole of redirect.html: pass Microsoft's answer (in this page's URL) back to the app's
// MSAL over a BroadcastChannel. It must not load the app, whose MSAL would read the answer first.
broadcastResponseToMainFrame().catch((error: unknown) => {
  console.error("Could not pass the sign-in answer back to the kitchen app", error);
});
