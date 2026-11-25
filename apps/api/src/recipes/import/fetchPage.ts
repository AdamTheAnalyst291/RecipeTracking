import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * Fetches a web page a person pasted the address of. The address is untrusted, and the API
 * runs inside Azure, so this only ever connects to the public internet: http or https on the
 * usual ports, every resolved address checked (and the connection pinned to those checked
 * addresses, so a name can't change its answer in between), each redirect checked afresh,
 * one deadline for the whole fetch, and a cap on the page's size after decompression.
 */
export type FetchErrorCode = "invalid_url" | "blocked" | "unreachable" | "timeout" | "too_large" | "http_error" | "not_html";

/** The message is for the person; it never says what an address resolved to. */
export class PageFetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchedPage {
  /** Where the page was after any redirects. */
  url: string;
  html: string;
}

export type FetchPage = (url: string) => Promise<FetchedPage>;

interface Address {
  address: string;
  family: number;
}

/** The defaults are what runs in the app; tests override them to use a local stand-in server. */
export interface FetcherOptions {
  resolve?: (hostname: string) => Promise<Address[]>;
  isAllowedAddress?: (address: string) => boolean;
  /** Ports other than 80 and 443 that a test's server listens on. */
  allowedPorts?: number[];
  maxBytes?: number;
  timeoutMs?: number;
}

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // Azure's own platform address, reachable from inside Azure though it looks public.
  ["168.63.129.16", 32],
] as const) {
  nonPublic.addSubnet(network, prefix, "ipv4");
}

// For IPv6 only global unicast is allowed (which leaves out loopback, link-local, private,
// mapped IPv4 and NAT64), less the parts of it that tunnel to IPv4 or are for documentation.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
specialV6.addSubnet("2001::", 23, "ipv6");
specialV6.addSubnet("2001:db8::", 32, "ipv6");
specialV6.addSubnet("2002::", 16, "ipv6");
specialV6.addSubnet("3fff::", 20, "ipv6");

export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !nonPublic.check(address, "ipv4");
    case 6:
      return !address.includes("%") && globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
    default:
      return false;
  }
}

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const badAddress = () => new PageFetchError("invalid_url", "Enter a web address that starts with http:// or https://.");
const blocked = () => new PageFetchError("blocked", "That address isn't a public website, so it can't be imported.");
const unreachable = () => new PageFetchError("unreachable", "That website couldn't be reached.");
const timedOut = () => new PageFetchError("timeout", "That website took too long to answer.");
const tooLarge = () => new PageFetchError("too_large", "That page is too large to import.");

export function createPageFetcher(options: FetcherOptions = {}): FetchPage {
  const resolve = options.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const extraPorts = options.allowedPorts ?? [];
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;

  function checkedUrl(text: string, base?: URL): URL {
    let url: URL;
    try {
      url = new URL(text, base);
    } catch {
      throw badAddress();
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw badAddress();
    if (url.port !== "" && !extraPorts.includes(Number(url.port))) throw blocked();
    return url;
  }

  /** The addresses to connect to, all of them allowed. */
  async function addressesOf(url: URL, signal: AbortSignal): Promise<Address[]> {
    // The abort event has already fired by now if a redirect used up the time.
    if (signal.aborted) throw timedOut();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: Address[];
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) }];
    } else {
      let onAbort = () => {};
      try {
        addresses = await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(timedOut());
            signal.addEventListener("abort", onAbort);
          }),
        ]);
      } catch (error) {
        throw error instanceof PageFetchError ? error : unreachable();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    if (addresses.length === 0) throw unreachable();
    if (!addresses.every((a) => allowed(a.address))) throw blocked();
    return addresses;
  }

  /** One GET, connected only to the given addresses. */
  function open(url: URL, addresses: Address[], signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((done, fail) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        url,
        {
          agent: false,
          signal,
          maxHeaderSize: 64 * 1024,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; KitchenRecipeImport/1.0)",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Encoding": "gzip, deflate, br",
          },
          // Node asks this instead of DNS, so it can only connect to what was just checked.
          lookup: (_hostname, lookupOptions, callback) => {
            const first = addresses[0] as Address;
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, first.address, first.family);
          },
        },
        done,
      );
      request.on("error", fail);
      // Neither a response nor an error arrives when a server "switches protocols".
      request.on("upgrade", (_response, socket) => socket.destroy());
      request.on("close", () => fail(unreachable()));
      request.end();
    });
  }

  async function body(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
    const unzip =
      encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
    let stream: Readable = response;
    if (unzip) {
      response.on("error", (error) => unzip.destroy(error));
      stream = response.pipe(unzip);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk as Buffer);
    }
    // A connection cut by the deadline can look like the end of the page.
    if (signal.aborted) throw timedOut();
    return Buffer.concat(chunks);
  }

  function textOf(bytes: Buffer, contentType: string): string {
    const charset =
      /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^<>]{0,200}?charset\s*=\s*["']?([\w-]+)/i.exec(bytes.toString("latin1", 0, 4096))?.[1];
    try {
      return new TextDecoder(charset ?? "utf-8").decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }

  return async (address) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = checkedUrl(address.trim());
    let response: IncomingMessage | undefined;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await open(url, await addressesOf(url, signal), signal);
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status) && response.headers.location) {
          response.destroy();
          url = checkedUrl(response.headers.location, url);
          continue;
        }
        if (status < 200 || status >= 300) {
          throw new PageFetchError("http_error", `That website answered with an error (HTTP ${status}).`);
        }
        const contentType = response.headers["content-type"] ?? "";
        if (contentType && !/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
          throw new PageFetchError("not_html", "That address isn't a web page.");
        }
        if (Number(response.headers["content-length"] ?? 0) > maxBytes) throw tooLarge();
        return { url: url.href, html: textOf(await body(response, signal), contentType) };
      }
      throw new PageFetchError("unreachable", "That website redirected too many times.");
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      throw signal.aborted ? timedOut() : unreachable();
    } finally {
      response?.destroy();
    }
  };
}
