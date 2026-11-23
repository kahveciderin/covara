import type { Context } from "hono";
import { ValidationError } from "@/resource/error";
import { getLogger } from "@/server/logger";
import { parseIp, parseRanges, inRanges, stripPort, type IpRange } from "@/server/ip";

interface NodeIncoming {
  incoming?: { socket?: { remoteAddress?: string } };
}

// false: no proxy, the socket address is the client. "cloudflare": trust
// CF-Connecting-IP (only when the origin accepts nothing but Cloudflare). A
// number: that many proxies in front, Express-style. A list: the addresses,
// CIDR ranges or named ranges (loopback, linklocal, uniquelocal) of trusted proxies.
export type TrustProxy = false | "cloudflare" | number | string[];

export interface ClientIpOptions {
  trustProxy?: TrustProxy;
  clientIp?: (c: Context) => string | undefined | null;
}

interface ClientIpConfig {
  trustProxy: false | "cloudflare" | number | IpRange[];
  clientIp?: ClientIpOptions["clientIp"];
}

let clientIpConfig: ClientIpConfig = { trustProxy: false };
let warnedIgnoredHeaders = false;

export const configureClientIp = (options: ClientIpOptions = {}): void => {
  const trust = options.trustProxy ?? false;
  if (typeof trust === "number" && !(Number.isInteger(trust) && trust >= 0)) {
    throw new Error("trustProxy: a hop count must be a non-negative integer");
  }
  clientIpConfig = {
    trustProxy: Array.isArray(trust) ? parseRanges(trust) : trust,
    clientIp: options.clientIp,
  };
  warnedIgnoredHeaders = false;
};

const isCloudflareWorkers = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

const forwardedFor = (c: Context): string[] =>
  (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => stripPort(entry))
    .filter((entry) => entry.length > 0);

const warnIgnoredHeaders = (c: Context): void => {
  if (warnedIgnoredHeaders) return;
  if (!c.req.header("x-forwarded-for") && !c.req.header("x-real-ip") && !c.req.header("cf-connecting-ip")) return;
  warnedIgnoredHeaders = true;
  getLogger().warn(
    "Ignoring X-Forwarded-For / X-Real-IP / CF-Connecting-IP from an untrusted peer: per-IP limits use the socket address. Behind a proxy, set createCovara({ trustProxy })"
  );
};

export const getClientIP = (c: Context): string => {
  const { trustProxy, clientIp } = clientIpConfig;
  const custom = clientIp?.(c);
  if (custom) return custom;

  const workers = isCloudflareWorkers();
  if (trustProxy === "cloudflare") {
    const cfIp = c.req.header("cf-connecting-ip")?.trim();
    if (cfIp) return cfIp;
  }
  const peer = workers
    ? c.req.header("cf-connecting-ip")?.trim() || "unknown"
    : ((c.env as NodeIncoming | undefined)?.incoming?.socket?.remoteAddress ?? "unknown");

  if (typeof trustProxy === "number") {
    const hops = [peer, ...forwardedFor(c).reverse()];
    return hops[Math.min(trustProxy, hops.length - 1)];
  }

  if (Array.isArray(trustProxy)) {
    const trusted = (address: string): boolean => {
      const parsed = parseIp(address);
      return !!parsed && inRanges(parsed, trustProxy);
    };
    if (!trusted(peer)) return peer;
    const entries = forwardedFor(c);
    if (entries.length === 0) return c.req.header("x-real-ip")?.trim() || peer;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!trusted(entries[i])) return entries[i];
    }
    return entries[0];
  }

  if (trustProxy === false && !workers) warnIgnoredHeaders(c);
  return peer;
};

export const readJsonBody = async (c: Context): Promise<unknown> => {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
};
