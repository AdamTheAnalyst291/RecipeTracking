/* global self, caches, fetch, URL */
// Keeps the app shell (the page and its built files) so the installed app starts fast.
// It is an allowlist: only this site's "/" and "/assets/*" are ever read from or put in the
// cache. The API (another origin), Microsoft sign-in, anything carrying a token and
// /config.json are left to the browser, so household data and tokens never reach a cache.

const CACHE = "kitchen-shell-v1";
const SHELL = "/";
// A Vary header on the server's answer must not hide a file we stored.
const MATCH = { ignoreVary: true };

function ruleFor(request) {
  if (request.method !== "GET" || request.headers.has("authorization")) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  // Microsoft sends the sign-in code back to "/"; the page is always stored as plain "/".
  if (request.mode === "navigate") return url.pathname === SHELL ? shell : null;
  return url.pathname.startsWith("/assets/") && url.search === "" ? asset : null;
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
  await cache.put(SHELL, response);
  for (const key of await cache.keys()) {
    const { pathname } = new URL(key.url);
    if (pathname.startsWith("/assets/") && !assets.includes(pathname)) await cache.delete(key);
  }
}

/** The page: from the network so a new deploy shows at once, from the cache when offline. */
async function shell(event) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    const cached = await cache.match(SHELL, MATCH);
    if (cached) return cached;
    throw error;
  }
  // A page that can't be stored still gets shown; the old shell stays cached whole.
  event.waitUntil(keepShell(cache, response.clone()).catch(() => {}));
  return response;
}

/** Built files have their content's hash in the name, so a cached one is never out of date. */
async function asset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, MATCH);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (isAsset(response)) await cache.put(event.request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await keepShell(await caches.open(CACHE), await fetch(SHELL, { cache: "no-cache" }));
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
  const answer = ruleFor(event.request);
  if (answer) event.respondWith(answer(event));
});
