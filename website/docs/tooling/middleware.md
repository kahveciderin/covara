---
id: middleware
title: Middleware
sidebar_label: Middleware
description: Observability metrics and tracing, structured logging, API versioning, idempotency keys, and rate limiting — all standard Hono middleware applied globally or per resource.
---

# Middleware

Covara ships several Hono middleware components. All are standard `MiddlewareHandler`s — apply with `app.use("*", ...)` or pass to `createCovara({ middleware: [...] })`.

Published subpaths: `covara/middleware/observability`, `/middleware/rateLimit`, `/middleware/error`, `/middleware/logging`, `/middleware/securityHeaders`. Versioning and idempotency live at `@/middleware/versioning` and `@/middleware/idempotency` in source and aren't yet package subpaths.

[Security headers](../auth/security-headers.md) and [error handling](./error-handling.md) have their own pages.

## Structured logging

Leveled JSON logging through a pluggable sink:

```typescript
import { getLogger, setLogger, createLogger } from "covara";

getLogger().info("server started", { port: 3000 });

setLogger(createLogger({
  level: "debug",
  sink: (record) => myTransport.write(record),
  base: { service: "api" },
}));

const reqLog = getLogger().child({ requestId });
reqLog.warn("slow query", { ms: 812 });
```

Levels: `debug | info | warn | error`. The default level comes from `COVARA_LOG_LEVEL` (falling back to `debug` in debug mode, else `info`). The default sink writes one JSON object per line to the matching `console` method; each record carries `level`, `time` (ISO 8601), `msg`, and your fields.

## Observability

```typescript
import { observabilityMiddleware, createMetricsCollector } from "covara/middleware/observability";

const metrics = createMetricsCollector({ maxMetrics: 1000 });

app.use("*", observabilityMiddleware({
  slowQueryThresholdMs: 500,
  requestIdHeader: "x-request-id",
  traceIdHeader: "traceparent",
  metrics: { onRequest: metrics.onRequest, onSubscription: metrics.onSubscription, onError: metrics.onError },
}));

const stats = metrics.getStats();           // totals, avg duration, error rate, req/min
const slow = metrics.getSlow(1000);
const byPath = metrics.getByPath("/api/users");
```

With `createCovara`, pass `observability: true` (defaults) or an `ObservabilityConfig`. Request tracing reads/propagates the `traceparent` header and invokes an optional `onSpan` hook with per-request timing.

| Collector method | Description |
|------------------|-------------|
| `record` / `onRequest` | Record a request metric |
| `getRecent(n)` | N most recent metrics |
| `getByPath(path)` | Metrics for a path |
| `getSlow(thresholdMs)` | Slow requests |
| `getRequestMetrics(filter?)` | Match a partial filter |
| `getSubscriptionMetrics()` / `getErrorMetrics()` | Subscription / error metrics |
| `getStats()` | Aggregate stats |
| `clear()` | Reset |

The [admin UI](./admin-ui.md) renders these metrics live.

## Versioning

```typescript
import { versioningMiddleware, wrapWithVersion, checkMinimumVersion, COVARA_VERSION } from "@/middleware/versioning";

app.use("*", versioningMiddleware({ headerName: "X-Covara-Version" }));

wrapWithVersion({ users: [] });                 // { data: {...}, version: "1.0.0", timestamp: "..." }
checkMinimumVersion("0.9.0", "1.0.0");          // { compatible, clientVersion, ... }
```

The framework also reads the request's API version into `c.get("apiVersion")`.

## Idempotency

```typescript
import { idempotencyMiddleware } from "@/middleware/idempotency";
import { createMemoryKV } from "covara/kv";

app.use("*", idempotencyMiddleware({
  storage: createMemoryKV(),       // any KVAdapter (Redis in production)
  ttlMs: 86_400_000,
  methods: ["POST", "PATCH", "PUT"],
  headerName: "idempotency-key",
  onStoreError: "proceed",         // "proceed" (default) | "fail"
}));
```

When a request carries an `Idempotency-Key`, the middleware returns the cached response if the key (and body) was seen before, otherwise processes and caches it.

`onStoreError` controls behavior when the KV is unreachable at lookup time:

- `"proceed"` (default) — log a warning and continue **without** replay protection (favors availability).
- `"fail"` — return RFC 7807 `503` so the client retries (favors correctness).

A failure while *caching* the response is always logged and swallowed; the response is still returned.

## Rate limiting

```typescript
import { createRateLimiter, createSlidingWindowRateLimiter } from "covara/middleware/rateLimit";
import { getClientIP } from "covara";

app.use("*", createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  keyGenerator: (c) => c.get("user")?.id ?? getClientIP(c),
  skip: (c) => c.req.path === "/healthz",
  // store: kvRateLimitStore, // distributed; default is in-memory
}));
```

`createSlidingWindowRateLimiter` is a sliding-window variant. Resources also accept a `rateLimit: { windowMs, maxRequests }` config directly — see [Resources](../core/resources-and-app.md#ratelimit). Provide a distributed `store` (KV/Redis) for multi-instance deployments.

## Related

- [Security headers](../auth/security-headers.md) · [Error handling](./error-handling.md) · [Admin UI](./admin-ui.md)
- [Optimistic locking](../core/optimistic-locking.md) · [KV store](../platform/kv.md)
