import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHash } from "node:crypto";
import { KVAdapter } from "@/kv";
import { IdempotencyMismatchError } from "@/resource/error";
import { getLogger } from "@/server/logger";

export interface IdempotencyConfig {
  storage: KVAdapter;
  ttlMs?: number;
  methods?: ("POST" | "PATCH" | "PUT" | "DELETE")[];
  paths?: string[];
  excludePaths?: string[];
  headerName?: string;
  // What to do when the idempotency store is unreachable:
  // - "proceed" (default): process the request without replay protection
  //   (favors availability; logged at warn).
  // - "fail": reject with 503 so the client retries (favors correctness — no
  //   risk of a non-idempotent operation running twice).
  onStoreError?: "proceed" | "fail";
}

interface CachedResponse {
  status: number;
  body: unknown;
  requestHash: string;
  createdAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_METHODS: IdempotencyConfig["methods"] = ["POST", "PATCH", "PUT"];
const DEFAULT_HEADER = "idempotency-key";

const hashRequest = (method: string, path: string, body: unknown): string => {
  const data = JSON.stringify({ method, path, body });
  return createHash("sha256").update(data).digest("hex");
};

const readBodyForHash = async (raw: Request): Promise<unknown> => {
  const text = await raw.clone().text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const idempotencyMiddleware = (config: IdempotencyConfig): MiddlewareHandler => {
  const {
    storage,
    ttlMs = DEFAULT_TTL_MS,
    methods = DEFAULT_METHODS,
    paths,
    excludePaths,
    headerName = DEFAULT_HEADER,
    onStoreError = "proceed",
  } = config;

  return async (c, next) => {
    const key = c.req.header(headerName);

    if (!key) {
      return next();
    }

    const method = c.req.method.toUpperCase() as "POST" | "PATCH" | "PUT" | "DELETE" | "GET";
    if (!methods.includes(method as (typeof methods)[number])) {
      return next();
    }

    if (paths && !paths.some((p) => c.req.path.startsWith(p))) {
      return next();
    }

    if (excludePaths && excludePaths.some((p) => c.req.path.startsWith(p))) {
      return next();
    }

    const userId = c.get("user")?.id ?? "anonymous";
    const body = await readBodyForHash(c.req.raw);
    const requestHash = hashRequest(c.req.method, c.req.path, body);
    const cacheKey = `idempotency:${userId}:${key}`;

    let parsedCache: CachedResponse | null = null;
    try {
      const cached = await storage.get(cacheKey);
      if (cached) {
        parsedCache = JSON.parse(cached) as CachedResponse;
      }
    } catch (error) {
      getLogger().warn("Idempotency store unreachable", {
        path: c.req.path,
        onStoreError,
        error: error instanceof Error ? error.message : String(error),
      });
      if (onStoreError === "fail") {
        return c.json(
          {
            type: "/__concave/problems/idempotency-store-unavailable",
            title: "Idempotency store unavailable",
            status: 503,
            detail: "The idempotency store is unreachable; retry shortly.",
          },
          503
        );
      }
      return next();
    }

    if (parsedCache) {
      if (parsedCache.requestHash !== requestHash) {
        throw new IdempotencyMismatchError(
          "Idempotency key was already used with different request parameters"
        );
      }

      return c.json(parsedCache.body, parsedCache.status as ContentfulStatusCode);
    }

    await next();

    if (c.res.status >= 500) return;

    const contentType = c.res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return;

    let responseBody: unknown;
    try {
      responseBody = await c.res.clone().json();
    } catch {
      return;
    }

    const cacheData: CachedResponse = {
      status: c.res.status,
      body: responseBody,
      requestHash,
      createdAt: Date.now(),
    };

    storage
      .set(cacheKey, JSON.stringify(cacheData), { px: ttlMs })
      .catch((err) => {
        getLogger().warn("Failed to cache idempotency response", {
          path: c.req.path,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
};

export const createIdempotencyMiddleware = idempotencyMiddleware;

export interface IdempotencyKeyGenerator {
  generate(): string;
  fromMutation(type: string, resource: string, objectId?: string): string;
}

export const createIdempotencyKeyGenerator = (): IdempotencyKeyGenerator => {
  return {
    generate(): string {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 15);
      return `${timestamp}-${random}`;
    },

    fromMutation(type: string, resource: string, objectId?: string): string {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      const parts = [type, resource];
      if (objectId) {
        parts.push(objectId);
      }
      parts.push(timestamp, random);
      return parts.join("-");
    },
  };
};

export const validateIdempotencyKey = (key: string): boolean => {
  if (!key || typeof key !== "string") {
    return false;
  }

  if (key.length < 8 || key.length > 256) {
    return false;
  }

  return /^[a-zA-Z0-9_-]+$/.test(key);
};

export const idempotencyKeyValidationMiddleware = (
  headerName: string = DEFAULT_HEADER
): MiddlewareHandler => {
  return async (c, next) => {
    const key = c.req.header(headerName);

    if (key && !validateIdempotencyKey(key)) {
      return c.json(
        {
          type: "/__concave/problems/validation-error",
          title: "Invalid idempotency key",
          status: 400,
          detail:
            "Idempotency key must be 8-256 characters and contain only alphanumeric characters, underscores, and hyphens",
        },
        400
      );
    }

    return next();
  };
};
