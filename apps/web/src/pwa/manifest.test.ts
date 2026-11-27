import { describe, expect, it } from "vitest";
import page from "../../index.html?raw";
import manifestText from "../../public/manifest.webmanifest?raw";
import hostingText from "../../public/staticwebapp.config.json?raw";

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

const manifest = JSON.parse(manifestText) as Manifest;
// Every PNG in public/, as base64 data URLs, keyed by the address it is served at.
const icons = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../public/*.png", { query: "?inline", import: "default", eager: true })).map(
    ([path, data]) => [path.replace("../../public", ""), data],
  ),
);

/** A PNG's width and height, read from its header. */
function pngSize(src: string): string {
  const data = icons[src];
  if (!data?.startsWith("data:image/png;base64,")) throw new Error(`No PNG at ${src}`);
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

const head = new RegExp(/<head>([\s\S]*)<\/head>/).exec(page)?.[1] ?? "";

describe("installing on a phone's home screen", () => {
  it("has a complete web app manifest that opens the app on its own", () => {
    expect(manifest).toMatchObject({
      id: "/",
      name: "Kitchen",
      short_name: "Kitchen",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("has the icon sizes Android needs, each the size it says", () => {
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(pngSize(icon.src)).toBe(icon.sizes);
    }
  });

  it("links the manifest, iOS's 180px icon and the theme colour from the page", () => {
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(head).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(pngSize("/apple-touch-icon.png")).toBe("180x180");
    expect(head).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(head).toContain('<meta name="apple-mobile-web-app-title" content="Kitchen" />');
    expect(head).toContain("viewport-fit=cover");
  });

  it("is served with the manifest's content type and an always-checked service worker", () => {
    const hosting = JSON.parse(hostingText) as {
      mimeTypes: Record<string, string>;
      routes: { route: string; headers: Record<string, string> }[];
    };
    const headers = (route: string) => hosting.routes.find((r) => r.route === route)?.headers;

    expect(hosting.mimeTypes[".webmanifest"]).toBe("application/manifest+json");
    expect(headers("/sw.js")).toEqual({ "cache-control": "no-cache", "content-type": "text/javascript; charset=utf-8" });
    expect(headers("/config.json")).toEqual({ "cache-control": "no-store" });
  });

  it("serves MSAL's redirect bridge as itself, never stored, with nothing cutting it off from the app", () => {
    const hosting = JSON.parse(hostingText) as {
      navigationFallback?: unknown;
      globalHeaders?: Record<string, string>;
      routes: { route: string; headers: Record<string, string> }[];
    };

    // A fallback would answer /redirect.html with the app's page; a COOP header would cut the
    // bridge's BroadcastChannel off from the app (MSAL's redirect-bridge guide).
    expect(hosting.navigationFallback).toBeUndefined();
    expect(Object.keys(hosting.globalHeaders ?? {}).map((name) => name.toLowerCase())).not.toContain("cross-origin-opener-policy");
    expect(hosting.routes.find((r) => r.route === "/redirect.html")?.headers).toEqual({ "cache-control": "no-store" });
  });
});
