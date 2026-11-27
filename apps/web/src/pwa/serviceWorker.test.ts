import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../public/sw.js?raw";

const ORIGIN = "https://kitchen.example.net";
const API = "https://api.example.net";
const LOGIN = "https://login.microsoftonline.com";

const html = (script: string) =>
  `<!doctype html><script type="module" crossorigin src="/assets/${script}"></script><link rel="stylesheet" crossorigin href="/assets/index-1.css">`;

/** Runs public/sw.js against a made-up network and an in-memory Cache Storage. */
function startWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const network = new Map<string, () => Response>();
  let online = true;
  let stalled = false;
  let full = false;

  const absolute = (input: string | { url: string }) => new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
  const serve = (body: string, type: string) => () => new Response(body, { headers: { "content-type": type } });
  const publish = (script: string) => {
    network.set(`${ORIGIN}/`, serve(html(script), "text/html"));
    network.set(`${ORIGIN}/assets/${script}`, serve(`// ${script}`, "text/javascript"));
    network.set(`${ORIGIN}/assets/index-1.css`, serve("body{}", "text/css"));
  };

  const fetchFn = async (input: string | { url: string }) => {
    const url = absolute(input);
    fetched.push(url);
    if (!online) throw new TypeError("Failed to fetch");
    if (stalled) return new Promise<Response>(() => {});
    return network.get(url.replace(/[?#].*$/, ""))?.() ?? new Response("Not found", { status: 404 });
  };

  const caches = {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (key: string | { url: string }) => store.get(absolute(key))?.clone(),
        put: async (key: string | { url: string }, response: Response) => {
          if (full) throw new Error("QuotaExceededError");
          store.set(absolute(key), response);
        },
        delete: async (key: string | { url: string }) => store.delete(absolute(key)),
        keys: async () => [...store.keys()].map((url) => ({ url })),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };

  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetchFn);

  const dispatch = async (type: string, extra: object = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners.get(type)?.({
      ...extra,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    try {
      return responded ? await responded : undefined;
    } finally {
      for (let i = 0; i < waits.length; i++) await waits[i];
    }
  };

  return {
    publish,
    network,
    stores,
    fetched,
    offline: () => (online = false),
    /** The network never answers. */
    stall: () => (stalled = true),
    fillStorage: () => (full = true),
    install: async () => {
      await dispatch("install");
      await dispatch("activate");
    },
    /** What the worker answers, or undefined when it leaves the request to the browser. */
    request: (url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) =>
      dispatch("fetch", {
        request: {
          url: new URL(url, ORIGIN).href,
          method: init.method ?? "GET",
          mode: init.mode ?? "cors",
          headers: new Headers(init.headers),
        },
      }),
    answer: (url: string) => {
      let responded: Promise<Response> | undefined;
      listeners.get("fetch")?.({
        request: { url: new URL(url, ORIGIN).href, method: "GET", mode: "navigate", headers: new Headers() },
        waitUntil: () => {},
        respondWith: (p: Promise<Response>) => (responded = p),
      });
      return responded ?? Promise.resolve(undefined);
    },
    cachedUrls: () => [...stores.values()].flatMap((store) => [...store.keys()]).sort(),
  };
}

const SHELL = [`${ORIGIN}/`, `${ORIGIN}/assets/index-1.css`, `${ORIGIN}/assets/index-aaa.js`];

describe("the service worker", () => {
  let worker: ReturnType<typeof startWorker>;

  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    worker = startWorker();
    worker.publish("index-aaa.js");
    await worker.install();
  });

  it("keeps the app shell on install: the page and the files it loads", () => {
    expect(worker.cachedUrls()).toEqual(SHELL);
  });

  it("answers the shell's files from the cache, without the network", async () => {
    worker.offline();

    const script = await worker.request("/assets/index-aaa.js");

    expect(await script?.text()).toBe("// index-aaa.js");
  });

  it("opens the app offline from the cached page", async () => {
    worker.offline();

    const page = await worker.request("/", { mode: "navigate" });

    expect(await page?.text()).toContain("index-aaa.js");
  });

  it("stops waiting for a stalled network and opens the cached page", async () => {
    vi.useFakeTimers();
    worker.stall();
    let page: Response | undefined;
    // The worker is still waiting on the network, so ask for the answer rather than the whole event.
    void worker.answer("/").then((response) => (page = response));

    await vi.advanceTimersByTimeAsync(3000);

    expect(await page?.text()).toContain("index-aaa.js");
  });

  it("opens the cached page when the server fails", async () => {
    worker.network.set(`${ORIGIN}/`, () => new Response("Oops", { status: 503 }));

    const page = await worker.request("/", { mode: "navigate" });

    expect(await page?.text()).toContain("index-aaa.js");
  });

  it("still serves a file it has no room to keep", async () => {
    worker.network.set(`${ORIGIN}/assets/late.js`, () => new Response("// late", { headers: { "content-type": "text/javascript" } }));
    worker.fillStorage();

    expect(await (await worker.request("/assets/late.js"))?.text()).toBe("// late");
  });

  it("takes the newly deployed page when online and drops the old files", async () => {
    worker.publish("index-bbb.js");

    const page = await worker.request("/", { mode: "navigate" });

    expect(await page?.text()).toContain("index-bbb.js");
    expect(worker.cachedUrls()).toEqual([`${ORIGIN}/`, `${ORIGIN}/assets/index-1.css`, `${ORIGIN}/assets/index-bbb.js`]);
  });

  it("keeps the old shell whole when a new page's files can't be fetched", async () => {
    worker.publish("index-bbb.js");
    worker.network.delete(`${ORIGIN}/assets/index-bbb.js`);

    await worker.request("/", { mode: "navigate" });
    worker.offline();

    expect(await (await worker.request("/", { mode: "navigate" }))?.text()).toContain("index-aaa.js");
    expect(worker.cachedUrls()).toEqual(SHELL);
  });

  it("handles Microsoft's redirect back without keeping the sign-in code", async () => {
    const page = await worker.request("/?code=secret-code&state=x#code=secret-code", { mode: "navigate" });

    expect(await page?.text()).toContain("index-aaa.js");
    expect(worker.cachedUrls()).toEqual(SHELL);
  });

  it.each([
    ["the API", `${API}/api/recipes`, {}],
    ["the API's health check", `${API}/api/health`, {}],
    ["an API path on this origin", "/api/me", {}],
    ["Microsoft sign-in", `${LOGIN}/tenant/oauth2/v2.0/authorize`, { mode: "navigate" }],
    ["Microsoft token requests", `${LOGIN}/tenant/oauth2/v2.0/token`, { method: "POST" }],
    ["anything carrying a token", "/assets/index-aaa.js", { headers: { Authorization: "Bearer token" } }],
    ["a change", "/assets/index-aaa.js", { method: "POST" }],
    ["the environment's settings", "/config.json", {}],
    ["another origin's files", `${API}/assets/index-aaa.js`, {}],
  ])("leaves %s to the browser and keeps nothing", async (_what, url, init) => {
    worker.network.set(url.startsWith("/") ? `${ORIGIN}${url}` : url, () => new Response("private"));

    await expect(worker.request(url, init)).resolves.toBeUndefined();
    expect(worker.cachedUrls()).toEqual(SHELL);
  });

  it("does not keep a missing file or an error page", async () => {
    const missing = await worker.request("/assets/gone.js");
    worker.network.set(`${ORIGIN}/assets/fallback.js`, () => new Response("<html>", { headers: { "content-type": "text/html" } }));
    await worker.request("/assets/fallback.js");

    expect(missing?.status).toBe(404);
    expect(worker.cachedUrls()).toEqual(SHELL);
  });

  it("clears shell caches from earlier versions and leaves other caches alone", async () => {
    worker.stores.set("kitchen-shell-v0", new Map());
    worker.stores.set("something-else", new Map());

    await worker.install();

    expect([...worker.stores.keys()].sort()).toEqual(["kitchen-shell-v1", "something-else"]);
  });
});
