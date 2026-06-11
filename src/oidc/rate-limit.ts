import type { Context, MiddlewareHandler } from "hono";
import { getClientIP } from "@/server/request";
import { getGlobalKV, hasGlobalKV } from "@/kv";

export interface OIDCRateLimitOptions {
  windowMs: number;
  max: number;
  prefix: string;
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

const incrementMemory = (
  key: string,
  windowMs: number
): { count: number; resetAt: number } => {
  const now = Date.now();
  const entry = memoryBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    memoryBuckets.set(key, fresh);
    return fresh;
  }
  entry.count++;
  return entry;
};

const incrementKv = async (
  key: string,
  windowMs: number
): Promise<{ count: number; resetAt: number }> => {
  const kv = getGlobalKV();
  const now = Date.now();
  const data = await kv.hgetall(key);

  let count: number;
  let resetAt: number;
  if (!data.resetAt || parseInt(data.resetAt, 10) <= now) {
    count = 1;
    resetAt = now + windowMs;
  } else {
    count = (parseInt(data.count, 10) || 0) + 1;
    resetAt = parseInt(data.resetAt, 10);
  }

  await kv.hmset(key, { count: String(count), resetAt: String(resetAt) });
  await kv.expire(key, Math.ceil((resetAt - now) / 1000) + 1);
  return { count, resetAt };
};

const keyFor = (c: Context, prefix: string): string => {
  const clientId =
    c.req.query("client_id") ?? c.req.header("x-client-id") ?? undefined;
  const ip = getClientIP(c);
  return `oidc:rl:${prefix}:${clientId ?? ip}`;
};

export const createOIDCRateLimiter = (
  options: OIDCRateLimitOptions
): MiddlewareHandler => {
  return async (c, next) => {
    const key = keyFor(c, options.prefix);
    const info = hasGlobalKV()
      ? await incrementKv(key, options.windowMs)
      : incrementMemory(key, options.windowMs);

    c.header("X-RateLimit-Limit", String(options.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, options.max - info.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(info.resetAt / 1000)));

    if (info.count > options.max) {
      const retryAfter = Math.ceil((info.resetAt - Date.now()) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          error: "rate_limited",
          error_description: "Too many requests, please try again later",
        },
        429
      );
    }

    return next();
  };
};

export const resetOIDCRateLimits = (): void => {
  memoryBuckets.clear();
};
