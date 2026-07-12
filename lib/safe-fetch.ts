import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-hardened fetch for user-supplied URLs.
 *
 * Guards:
 * - http/https only (no file:, gopher:, etc.)
 * - hostname must not resolve to a private, loopback, link-local, or
 *   metadata address (blocks 169.254.169.254 cloud-metadata reads,
 *   localhost, RFC-1918 ranges, and IPv6 equivalents)
 * - redirects are followed manually and every hop is re-validated
 *   (blocks redirect-based SSRF)
 * - response body capped at maxBytes (default 25 MB)
 *
 * Trusted, hard-coded hosts (e.g. googleapis.com in drive-import) do not
 * need this; use it for any URL that originates from user input.
 */

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function ipIsPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 192 && b === 0) || // 192.0.0/24 special
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast + reserved
    );
  }
  // IPv6
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" || // loopback
    v6.startsWith("fe80") || // link-local
    v6.startsWith("fc") || // unique-local fc00::/7
    v6.startsWith("fd") ||
    v6.startsWith("::ffff:") // v4-mapped — re-check the v4 part
      ? v6.startsWith("::ffff:")
        ? ipIsPrivate(v6.slice(7))
        : true
      : false
  );
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Blocked host");
  }
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error("Blocked IP range");
    return;
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("Host did not resolve");
  for (const { address } of addrs) {
    if (ipIsPrivate(address)) throw new Error("Blocked IP range");
  }
}

export async function safeFetch(
  rawUrl: string,
  init: Omit<RequestInit, "redirect"> & { maxBytes?: number } = {}
): Promise<{ res: Response; body: Buffer }> {
  const { maxBytes = DEFAULT_MAX_BYTES, ...rest } = init;
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { ...rest, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect (${res.status}) without location`);
      url = new URL(loc, url); // relative redirects resolve against current
      continue;
    }

    // Stream with a size cap instead of buffering blindly.
    const reader = res.body?.getReader();
    if (!reader) return { res, body: Buffer.alloc(0) };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
      }
      chunks.push(Buffer.from(value));
    }
    return { res, body: Buffer.concat(chunks) };
  }
  throw new Error("Too many redirects");
}
