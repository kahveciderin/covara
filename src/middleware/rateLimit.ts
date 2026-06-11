import type { Context, MiddlewareHandler } from "hono";
import { RateLimitError } from "@/resource/error";
import { getClientIP } from "@/server/request";
import { getGlobalKV, hasGlobalKV } from "../kv";

const RATE_LIMIT_PREFIX = "concave:ratelimit:";
const SLIDING_WINDOW_PREFIX = "concave:ratelimit:sliding:";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: Context) => string;
  skip?: (c: Context) => boolean;
  message?: string;
  headers?: boolean;
  store?: RateLimitStore;
}

export interface RateLimitInfo {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitInfo>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/**
 * In-memory rate limit store for single-process deployments
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; resetAt: number }>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    if (typeof this.cleanupInterval === "object" && "unref" in this.cleanupInterval) {
      this.cleanupInterval.unref();
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || entry.resetAt <= now) {
      const info = { count: 1, resetAt: now + windowMs };
      this.store.set(key, info);
      return info;
    }

    entry.count++;
    return entry;
  }

  async decrement(key: string): Promise<void> {
    const entry = this.store.get(key);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.resetAt <= now) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

/**
 * KV-backed rate limit store for multi-process deployments
 * Uses the global KV adapter (Redis or memory)
 */
export class KVRateLimitStore implements RateLimitStore {
  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;

    if (!kv) {
      return { count: 1, resetAt: Date.now() + windowMs };
    }

    const kvKey = `${RATE_LIMIT_PREFIX}${key}`;
    const now = Date.now();

    const data = await kv.hgetall(kvKey);

    let count: number;
    let resetAt: number;

    if (!data.resetAt || parseInt(data.resetAt, 10) <= now) {
      count = 1;
      resetAt = now + windowMs;
    } else {
      count = (parseInt(data.count, 10) || 0) + 1;
      resetAt = parseInt(data.resetAt, 10);
    }

    await kv.hmset(kvKey, {
      count: String(count),
      resetAt: String(resetAt),
    });

    const ttl = Math.ceil((resetAt - now) / 1000) + 1;
    await kv.expire(kvKey, ttl);

    return { count, resetAt };
  }

  async decrement(key: string): Promise<void> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;
    if (!kv) return;

    const kvKey = `${RATE_LIMIT_PREFIX}${key}`;
    const data = await kv.hgetall(kvKey);

    if (data.count) {
      const newCount = Math.max(0, parseInt(data.count, 10) - 1);
      await kv.hset(kvKey, "count", String(newCount));
    }
  }

  async reset(key: string): Promise<void> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;
    if (!kv) return;

    await kv.del(`${RATE_LIMIT_PREFIX}${key}`);
  }
}

const defaultKeyGenerator = (c: Context): string => {
  const userId = c.get("user")?.id;

  if (userId) {
    return `user:${userId}`;
  }
  return `ip:${getClientIP(c)}`;
};

let defaultStore: RateLimitStore | null = null;

const getDefaultStore = (): RateLimitStore => {
  if (!defaultStore) {
    if (hasGlobalKV()) {
      defaultStore = new KVRateLimitStore();
    } else {
      defaultStore = new InMemoryRateLimitStore();
    }
  }
  return defaultStore;
};

export const createRateLimiter = (config: RateLimitConfig): MiddlewareHandler => {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = "Too many requests, please try again later",
    headers = true,
    store,
  } = config;

  return async (c, next) => {
    if (skip?.(c)) {
      return next();
    }

    const key = keyGenerator(c);
    const actualStore = store ?? getDefaultStore();
    const info = await actualStore.increment(key, windowMs);

    if (headers) {
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(Math.max(0, maxRequests - info.count)));
      c.header("X-RateLimit-Reset", String(Math.ceil(info.resetAt / 1000)));
    }

    if (info.count > maxRequests) {
      const retryAfter = Math.ceil((info.resetAt - Date.now()) / 1000);

      if (headers) {
        c.header("Retry-After", String(retryAfter));
      }

      throw new RateLimitError(retryAfter, message);
    }

    return next();
  };
};

/**
 * Sliding window rate limiter using sorted sets in KV
 * More accurate than fixed window but more expensive
 */
export const createSlidingWindowRateLimiter = (config: RateLimitConfig): MiddlewareHandler => {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    headers = true,
  } = config;

  const localRequests = new Map<string, number[]>();

  const cleanupLocal = (key: string, now: number): number[] => {
    const timestamps = localRequests.get(key) ?? [];
    const cutoff = now - windowMs;
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      localRequests.delete(key);
    } else {
      localRequests.set(key, valid);
    }
    return valid;
  };

  return async (c, next) => {
    if (skip?.(c)) {
      return next();
    }

    const key = keyGenerator(c);
    const now = Date.now();
    const cutoff = now - windowMs;

    const kv = hasGlobalKV() ? getGlobalKV() : null;

    let requestCount: number;
    let oldestTimestamp: number | null = null;

    if (kv) {
      const kvKey = `${SLIDING_WINDOW_PREFIX}${key}`;

      const oldEntries = await kv.zrangebyscore(kvKey, "-inf", cutoff);
      if (oldEntries.length > 0) {
        await kv.zrem(kvKey, ...oldEntries);
      }

      await kv.zadd(kvKey, now, `${now}:${Math.random()}`);

      await kv.expire(kvKey, Math.ceil(windowMs / 1000) + 1);

      requestCount = await kv.zcard(kvKey);

      if (requestCount >= maxRequests) {
        const oldest = await kv.zrange(kvKey, 0, 0);
        if (oldest.length > 0) {
          oldestTimestamp = parseInt(oldest[0].split(":")[0], 10);
        }
      }
    } else {
      const timestamps = cleanupLocal(key, now);
      requestCount = timestamps.length;

      if (requestCount >= maxRequests) {
        oldestTimestamp = timestamps[0] ?? null;
      } else {
        timestamps.push(now);
        localRequests.set(key, timestamps);
        requestCount = timestamps.length;
      }
    }

    if (headers) {
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(Math.max(0, maxRequests - requestCount)));
    }

    if (requestCount > maxRequests && oldestTimestamp) {
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      if (headers) {
        c.header("Retry-After", String(retryAfter));
        c.header("X-RateLimit-Reset", String(Math.ceil((oldestTimestamp + windowMs) / 1000)));
      }

      throw new RateLimitError(retryAfter);
    }

    return next();
  };
};

export const createResourceRateLimiter = (
  resourceName: string,
  config: RateLimitConfig
): MiddlewareHandler => {
  return createRateLimiter({
    ...config,
    keyGenerator: (c) => {
      const baseKey = config.keyGenerator?.(c) ?? defaultKeyGenerator(c);
      return `${resourceName}:${baseKey}`;
    },
  });
};

export interface OperationRateLimits {
  read?: RateLimitConfig;
  create?: RateLimitConfig;
  update?: RateLimitConfig;
  delete?: RateLimitConfig;
  subscribe?: RateLimitConfig;
}

export const createOperationRateLimiter = (
  resourceName: string,
  limits: OperationRateLimits
) => {
  const limiters: Record<string, MiddlewareHandler> = {};

  for (const [op, config] of Object.entries(limits)) {
    if (config) {
      limiters[op] = createResourceRateLimiter(`${resourceName}:${op}`, config);
    }
  }

  const passthrough: MiddlewareHandler = async (_c, next) => next();

  return (operation: keyof OperationRateLimits): MiddlewareHandler => {
    return limiters[operation] ?? passthrough;
  };
};

export const rateLimitPresets = {
  standard: { windowMs: 60 * 1000, maxRequests: 100 },
  strict: { windowMs: 60 * 1000, maxRequests: 20 },
  lenient: { windowMs: 60 * 1000, maxRequests: 1000 },
  auth: { windowMs: 60 * 1000, maxRequests: 5 },
  subscription: { windowMs: 60 * 1000, maxRequests: 10 },
};

/**
 * Reset the default store (useful for testing)
 */
export const resetDefaultStore = (): void => {
  if (defaultStore instanceof InMemoryRateLimitStore) {
    defaultStore.destroy();
  }
  defaultStore = null;
};
