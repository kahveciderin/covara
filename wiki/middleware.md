# Middleware

Covara provides several Hono middleware components for observability, versioning, idempotency, and rate limiting. All of them are standard `MiddlewareHandler`s — apply them with `app.use("*", ...)` or pass them to `createCovara({ middleware: [...] })`.

Published package subpaths: `covara/middleware/observability`, `/middleware/rateLimit`, `/middleware/error`, and `/middleware/logging`. The versioning and idempotency middleware live at `@/middleware/versioning` and `@/middleware/idempotency` in the framework source and are not yet exposed as package subpaths.

## Security Headers

`createCovara` auto-mounts security headers on every response unless you set
`securityHeaders: false`. Pass a `SecurityHeadersOptions` object to customize, or use the
middleware standalone:

```typescript
import { createSecurityHeaders } from "covara";

app.use("*", createSecurityHeaders({
  contentSecurityPolicy: "default-src 'self'", // string or false
  frameOptions: "DENY",                         // "DENY" | "SAMEORIGIN" | false
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false }, // or false
}));
```

Defaults (each header is only set if not already present on the response):

| Header | Default |
|--------|---------|
| `Content-Security-Policy` | **off** (opt-in — see below) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-DNS-Prefetch-Control` | `off` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` |

HSTS is only emitted on HTTPS requests or when running in production
(`isProduction()`), so it never appears on plain-HTTP local development. Any header can be
disabled by setting its option to `false`.

### Content-Security-Policy is opt-in

CSP is **off by default** because it is application-specific: a strict policy that's correct
for a JSON-only API will block an app that serves its own frontend (its scripts, styles, and
images). Enable it by passing a policy string:

```typescript
import { createSecurityHeaders, STRICT_API_CSP } from "covara";

// Pure JSON API — lock everything down:
createSecurityHeaders({ contentSecurityPolicy: STRICT_API_CSP });
// → "default-src 'none'; frame-ancestors 'none'"

// App that serves a frontend — allow same-origin assets (tune to your build):
createSecurityHeaders({ contentSecurityPolicy: "default-src 'self'" });
```

`createCovara` mounts security headers automatically (configurable via the `securityHeaders`
option), so anti-clickjacking (`X-Frame-Options: DENY`), MIME-sniffing protection, and the
other headers are always on — only the CSP requires you to choose a policy. The built-in
admin UI sets its own self-only CSP regardless.

## Structured Logging

Covara logs as leveled JSON through a pluggable sink. The global logger is used by the
framework and is available to your code:

```typescript
import { getLogger, setLogger, createLogger } from "covara";

getLogger().info("server started", { port: 3000 });

// Swap the sink (e.g. ship to a log aggregator)
setLogger(createLogger({
  level: "debug",
  sink: (record) => myTransport.write(record),
  base: { service: "api" },
}));

// Scoped child loggers
const reqLog = getLogger().child({ requestId });
reqLog.warn("slow query", { ms: 812 });
```

Levels are `debug | info | warn | error`. The default level comes from
`COVARA_LOG_LEVEL` (falling back to `debug` when debug mode is enabled, otherwise `info`).
The default sink writes one JSON object per line to the matching `console` method. Each
record carries `level`, `time` (ISO 8601), `msg`, and any structured fields.

Request tracing lives in the observability middleware: it reads/propagates the
`traceparent` header (configurable via `traceIdHeader`) and invokes the optional `onSpan`
hook with span timing for each request.

## Observability

Track request metrics and performance:

```typescript
import { observabilityMiddleware, createMetricsCollector } from "covara/middleware/observability";

const metrics = createMetricsCollector({ maxMetrics: 1000 });

app.use("*", observabilityMiddleware({
  slowQueryThresholdMs: 500,
  requestIdHeader: "x-request-id",
  metrics: {
    onRequest: metrics.onRequest,
    onSubscription: metrics.onSubscription,
    onError: metrics.onError,
  },
}));

// Later: access metrics
const recent = metrics.getRecent(10);
const slow = metrics.getSlow(1000);
const byPath = metrics.getByPath("/api/users");
const stats = metrics.getStats();
```

With `createCovara`, pass `observability: true` (defaults) or an `ObservabilityConfig` object.

### Metrics Collector API

| Method | Description |
|--------|-------------|
| `record(metrics)` / `onRequest(metrics)` | Record a request metric |
| `getRecent(count)` | Get the N most recent metrics |
| `getByPath(path)` | Get metrics for a specific path |
| `getSlow(thresholdMs)` | Get requests slower than threshold |
| `getRequestMetrics(filter?)` | Get metrics matching a partial filter |
| `getSubscriptionMetrics()` / `getErrorMetrics()` | Subscription / error metrics |
| `getStats()` | Totals, average duration, error rate, requests/min |
| `clear()` | Clear all metrics |

## Versioning

API version management with client compatibility:

```typescript
import { versioningMiddleware, wrapWithVersion, checkMinimumVersion, COVARA_VERSION } from "@/middleware/versioning";

// Add version headers to responses
app.use("*", versioningMiddleware({
  headerName: "X-Covara-Version",
}));

// Wrap response data with version info
const response = wrapWithVersion({ users: [] });
// { data: { users: [] }, version: "1.0.0", timestamp: "..." }

// Check client version compatibility
const result = checkMinimumVersion("0.9.0", "1.0.0");
// { compatible: true, clientVersion: { major: 0, minor: 9, patch: 0 }, ... }
```

## Idempotency

Prevent duplicate requests with idempotency keys:

```typescript
import { idempotencyMiddleware } from "@/middleware/idempotency";
import { createMemoryKV } from "covara/kv";

app.use("*", idempotencyMiddleware({
  storage: createMemoryKV(),       // any KVAdapter (Redis in production)
  ttlMs: 86400000,                 // 24 hours
  methods: ["POST", "PATCH", "PUT"],
  headerName: "idempotency-key",
  onStoreError: "proceed",         // "proceed" (default) | "fail"
}));
```

When a request includes an `Idempotency-Key` header, the middleware:
1. Checks if the key has been seen before
2. If yes (and the request body matches), returns the cached response
3. If no, processes the request and caches the response

### Store Unavailability

`onStoreError` controls what happens if the idempotency KV store is unreachable when the key is
looked up:

- `"proceed"` (default) — logs a warning and lets the request through **without** replay protection.
  Favors availability; the operation may run more than once if the store is down.
- `"fail"` — returns an RFC 7807 `503` (`/__covara/problems/idempotency-store-unavailable`) so the
  client retries. Favors correctness, ensuring a non-idempotent operation is never run unprotected.

A failure while *caching* the response (the write after the request completes) is always logged and
swallowed regardless of `onStoreError` — the response is still returned.

## ETag Support

ETags and optimistic concurrency are built into resources — enable them with the `etag` option:

```typescript
useResource(postsTable, {
  id: postsTable.id,
  db,
  etag: {
    versionField: "version",     // preferred: integer column, auto-incremented on update
    // updatedAtField: "updatedAt",  // alternative: timestamp-based tags
    // idField: "id",
    // algorithm: "weak",            // "weak" (default) or "strong"
  },
});
```

Behavior when enabled:

- `POST /`, `GET /:id`, `PATCH /:id`, `PUT /:id` responses include an `ETag` header.
- `If-Match` is checked on `PATCH`, `PUT`, and `DELETE`; a mismatch returns `412 Precondition Failed`. `If-Match: *` matches any current state.
- `If-None-Match` on `GET /:id` returns `304 Not Modified` when the tag matches.
- With `versionField` set, the field is automatically incremented on every update (optimistic locking).

```bash
# Get resource with ETag
GET /posts/1
# Response: ETag: W/"3"

# Update only if unchanged
PATCH /posts/1
If-Match: W/"3"
Content-Type: application/json
{ "title": "Updated" }
# 200 with ETag: W/"4" — or 412 if someone else updated first
```

See the [ETag contract](../contracts/etag.md) for the precise guarantees.

## Rate Limiting

Per-resource rate limiting:

```typescript
import { createRateLimiter } from "covara/middleware/rateLimit";
import { getClientIP } from "covara";

app.use("*", createRateLimiter({
  windowMs: 60000,    // 1 minute window
  maxRequests: 100,   // Max 100 requests
  keyGenerator: (c) => c.get("user")?.id ?? getClientIP(c),
  skip: (c) => c.req.path === "/healthz",
}));
```

`keyGenerator` and `skip` receive the Hono `Context`. A `store` can be provided for distributed deployments (`KVRateLimitStore` backed by Redis); the default is in-memory. `createSlidingWindowRateLimiter` offers a sliding-window variant, and resources accept a `rateLimit` config directly.

## Related

- [Resources](./resources.md) - Core resource configuration
- [Error Handling](./error-handling.md) - Error responses and types
