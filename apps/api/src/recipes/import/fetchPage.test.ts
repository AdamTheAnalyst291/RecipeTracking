import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPageFetcher, isPublicAddress, PageFetchError, type FetcherOptions } from "./fetchPage.js";

describe("which addresses are public", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "168.63.129.16", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "fe80::1", "fc00::1", "fd00:ec2::254",
    "ff02::1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001::1", "2001:db8::1", "not an address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

const failure = async (fetching: Promise<unknown>): Promise<string> => {
  try {
    await fetching;
  } catch (error) {
    if (error instanceof PageFetchError) return error.code;
    throw error;
  }
  throw new Error("The fetch succeeded");
};

describe("what may be fetched", () => {
  // No request is ever sent in these: every one is refused first.
  const fetchPage = createPageFetcher({ resolve: async () => [{ address: "93.184.216.34", family: 4 }] });

  it.each(["", "not a url", "ftp://example.com/x", "file:///etc/passwd", "data:text/html,hi", "http://user:secret@example.com/"])(
    "refuses %j as an address",
    async (url) => {
      expect(await failure(fetchPage(url))).toBe("invalid_url");
    },
  );

  it.each([
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://169.254.169.254/metadata/instance",
    "https://10.0.0.5/",
    "http://example.com:8080/",
    "https://example.com:1433/",
  ])("refuses %s", async (url) => {
    expect(await failure(fetchPage(url))).toBe("blocked");
  });

  it("refuses a name that resolves to a private address, even alongside a public one", async () => {
    const sneaky = createPageFetcher({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    });

    expect(await failure(sneaky("http://recipes.example/"))).toBe("blocked");
  });

  it("refuses localhost by name", async () => {
    expect(await failure(createPageFetcher()("http://localhost/"))).toBe("blocked");
  });
});

describe("fetching a page", () => {
  let server: Server;
  let port: number;
  const routes: Record<string, RequestListener> = {
    "/page": (_q, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>crème</p>"),
    "/latin1": (_q, res) => res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" }).end(Buffer.from("crème", "latin1")),
    "/zipped": (_q, res) => res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipSync("<p>small</p>")),
    "/bomb": (_q, res) =>
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipSync("a".repeat(100_000))),
    "/huge": (_q, res) => res.writeHead(200, { "content-type": "text/html" }).end("a".repeat(100_000)),
    "/endless": (_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("a".repeat(20_000)), 1);
      res.on("close", () => clearInterval(timer));
    },
    "/slow": (_q, res) => void res.writeHead(200, { "content-type": "text/html" }).write("<p>"),
    "/silent": () => undefined,
    // A reply that switches protocols never becomes an ordinary response.
    "/upgrade": (req) => void req.socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: made-up", "Connection: Upgrade", "", ""].join("\r\n")),
    "/moved": (_q, res) => res.writeHead(301, { location: "/page" }).end(),
    "/to-private": (_q, res) => res.writeHead(302, { location: "http://10.0.0.1/" }).end(),
    "/to-file": (_q, res) => res.writeHead(302, { location: "file:///etc/passwd" }).end(),
    "/loop": (_q, res) => res.writeHead(302, { location: "/loop" }).end(),
    "/missing": (_q, res) => res.writeHead(404, { "content-type": "text/html" }).end("no"),
    "/pdf": (_q, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF"),
  };

  beforeAll(async () => {
    server = createServer((req, res) => routes[req.url ?? ""]?.(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  // The local server stands in for a website, so the test lets 127.0.0.1 and its port through.
  // Every other address is still judged by the real rule.
  const options = (): FetcherOptions => ({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isAllowedAddress: (address) => address === "127.0.0.1" || isPublicAddress(address),
    allowedPorts: [port],
    maxBytes: 50_000,
    timeoutMs: 500,
  });
  const get = (path: string) => createPageFetcher(options())(`http://recipes.example:${port}${path}`);

  it("returns the page's text and address", async () => {
    expect(await get("/page")).toEqual({ url: `http://recipes.example:${port}/page`, html: "<p>crème</p>" });
  });

  it("reads other encodings and compressed pages", async () => {
    expect((await get("/latin1")).html).toBe("crème");
    expect((await get("/zipped")).html).toBe("<p>small</p>");
  });

  it("follows a redirect and reports where it ended up", async () => {
    expect((await get("/moved")).url).toBe(`http://recipes.example:${port}/page`);
  });

  it.each([
    ["/huge", "too_large"],
    ["/bomb", "too_large"],
    ["/endless", "too_large"],
    ["/slow", "timeout"],
    ["/silent", "timeout"],
    ["/upgrade", "unreachable"],
    ["/to-private", "blocked"],
    ["/to-file", "invalid_url"],
    ["/loop", "unreachable"],
    ["/missing", "http_error"],
    ["/pdf", "not_html"],
  ])("gives up on %s (%s)", async (path, code) => {
    expect(await failure(get(path))).toBe(code);
  });

  it("says so when the site can't be reached", async () => {
    const nowhere = createPageFetcher({ resolve: async () => Promise.reject(new Error("ENOTFOUND")) });

    expect(await failure(nowhere("http://no-such-site.example/"))).toBe("unreachable");
  });

  it("gives up on a name lookup that never answers", async () => {
    const stuck = createPageFetcher({ resolve: () => new Promise(() => undefined), timeoutMs: 100 });

    expect(await failure(stuck("http://slow-dns.example/"))).toBe("timeout");
  });
});
