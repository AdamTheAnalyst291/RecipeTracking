/** Turns on the app shell cache (public/sw.js). Only in a built app, so `pnpm dev` is never cached. */
export function registerServiceWorker(enabled: boolean = import.meta.env.PROD): void {
  if (!enabled || !("serviceWorker" in navigator)) return;
  const register = () => {
    // Without it the app still works, it only starts from the network.
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("No offline app shell", error));
  };
  window.addEventListener("load", register, { once: true });
}
