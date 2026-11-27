/* global self, caches, fetch, URL, setTimeout */
// Keeps the app shell (the page and its built files) so the installed app starts fast.
// It is an allowlist: only this site's "/" and "/assets/*" are ever read from or put in the
// cache. The API (another origin), Microsoft sign-in, anything carrying a token and
// /config.json are left to the browser, so household data and tokens never reach a cache.

const CACHE = "kitchen-shell-v1";
const PAGE_PATH = "/";
// How long a page load waits for the network before showing the stored page.
const PATIENCE_MS = 3000;
// A Vary header on the server's answer must not hide a file we stored.
const MATCH = { ignoreVary: true };

function handlerFor(request) {
  if (request.method !== "GET" || request.headers.has("authorization")) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  // Microsoft sends the sign-in code back to "/"; the page is always stored as plain "/".
  if (request.mode === "navigate") return url.pathname === PAGE_PATH ? servePage : null;
  return url.pathname.startsWith("/assets/") && url.search === "" ? serveAsset : null;
}

const isPage = (response) => (response.headers.get("content-type") ?? "").includes("text/html");
/** A real file, not an error or the HTML page a server may answer a missing file with. */
const isAsset = (response) => response.ok && !response.redirected && !isPage(response);

async function addAsset(cache, path) {
  if (await cache.match(path, MATCH)) return;
  const response = await fetch(path);
  if (!isAsset(response)) throw new Error(`Could not cache ${path}`);
  await cache.put(path, response);
}

/** Stores a new page only once all its files are stored, then drops the files it no longer uses. */
async function keepShell(cache, response) {
  if (!response.ok || response.redirected || !isPage(response)) throw new Error("Not the app page");
  const assets = [...new Set((await response.clone().text()).match(/\/assets\/[\w.-]+/g))];
  await Promise.all(assets.map((path) => addAsset(cache, path)));
  await cache.put(PAGE_PATH, response);
  for (const key of await cache.keys()) {
    const { pathname } = new URL(key.url);
    if (pathname.startsWith("/assets/") && !assets.includes(pathname)) await cache.delete(key);
  }
}

// Page loads can overlap (two tabs); storing them one at a time keeps one's files from
// being dropped by another's tidy-up.
let storing = Promise.resolve();
function storeInTurn(cache, response) {
  const turn = storing.then(() => keepShell(cache, response));
  storing = turn.catch(() => {});
  return storing;
}

/**
 * The page: from the network so a new deploy shows at once. The stored page stands in when
 * the network is offline, failing or slow.
 */
async function servePage(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(PAGE_PATH, MATCH);
  const network = fetch(event.request);
  // A page that can't be stored still gets shown; the old shell stays cached whole.
  event.waitUntil(
    network.then(
      (response) => storeInTurn(cache, response.clone()),
      () => {},
    ),
  );
  if (!cached) return network;
  const patience = new Promise((resolve) => setTimeout(resolve, PATIENCE_MS, cached));
  return Promise.race([
    network.then(
      (response) => (response.status >= 500 ? cached : response),
      () => cached,
    ),
    patience,
  ]);
}

/** Built files have their content's hash in the name, so a cached one is never out of date. */
async function serveAsset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, MATCH);
  if (cached) return cached;
  const response = await fetch(event.request);
  // With no room left to store it, the file is still served.
  if (isAsset(response)) await cache.put(event.request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await keepShell(await caches.open(CACHE), await fetch(PAGE_PATH, { cache: "no-cache" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("kitchen-shell-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const handler = handlerFor(event.request);
  if (handler) event.respondWith(handler(event));
});
