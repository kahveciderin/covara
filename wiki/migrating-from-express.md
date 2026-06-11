# Migrating from Express

Concave moved from Express to [Hono](https://hono.dev). The HTTP API is unchanged — same endpoints, payloads, status codes, headers, and query parameters — so API consumers and the client library need no changes. Server setup code does.

Why: Hono runs on Node *and* Cloudflare Workers, has first-class TypeScript types, and removes the `express`/`cookie-parser` dependencies entirely.

## App Setup

**Before (Express):**

```typescript
import express from "express";
import { useResource, errorMiddleware } from "@kahveciderin/concave";

const app = express();
app.use(express.json());
app.use("/api/todos", useResource(todosTable, { id: todosTable.id, db }));
app.use(errorMiddleware);
app.listen(3000);
```

**After (Hono):**

```typescript
import { createConcave } from "@kahveciderin/concave";
import { startServer } from "@kahveciderin/concave/node";

const app = createConcave({ cors: true })
  .resource(todosTable, { id: todosTable.id, db });   // mounts at /api/todos

await startServer(app, { port: 3000 });
```

Or with a plain Hono app:

```typescript
import { Hono } from "hono";
import { useResource, errorHandler, notFoundHandler } from "@kahveciderin/concave";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.route("/api/todos", useResource(todosTable, { id: todosTable.id, db }));
```

Notes:

- `useResource` now returns a `Hono` router. Mount with `app.route(path, router)`, **not** `app.use(path, router)`.
- Body parsing is built in — `express.json()` / `express.urlencoded()` are gone.
- `app.listen` is replaced by `startServer` (Node) or exporting the app as a Worker fetch handler (see [Deployment](./deployment.md)).

## API Mapping

### Routers and Mounting

| Express era | Hono era |
|---|---|
| `express()` | `createConcave(options)` or `new Hono()` |
| `app.use("/path", router)` | `app.route("/path", router)` |
| `app.use(middleware)` | `app.use("*", middleware)` |
| `app.listen(port)` | `await startServer(app, { port })` from `@kahveciderin/concave/node` |
| `asyncHandler(fn)` | removed — Hono awaits handlers; just `throw` errors |
| `errorMiddleware` | `app.onError(errorHandler)` + `app.notFound(notFoundHandler)` (automatic with `createConcave`) |
| `next(error)` | `throw error` |

### Request / Response in Custom Routes

Handlers receive a single Hono `Context` (`c`) and must **return** a `Response`:

| Express | Hono |
|---|---|
| `req.params.id` | `c.req.param("id")` |
| `req.query.foo` | `c.req.query("foo")` |
| `req.body` | `await c.req.json()` |
| `req.headers["x-foo"]` | `c.req.header("x-foo")` |
| `req.cookies.foo` | `getCookie(c, "foo")` from `hono/cookie` |
| `req.ip` | `getClientIP(c)` from `@kahveciderin/concave` |
| `res.json(x)` | `return c.json(x)` |
| `res.status(201).json(x)` | `return c.json(x, 201)` |
| `res.status(204).end()` | `return c.body(null, 204)` |
| `res.send(html)` | `return c.html(html)` |
| `res.redirect(url)` | `return c.redirect(url)` |
| `res.setHeader(k, v)` | `c.header(k, v)` (before returning) |
| `res.cookie(k, v, opts)` | `setCookie(c, k, v, opts)` from `hono/cookie` |
| `res.clearCookie(k)` | `deleteCookie(c, k)` from `hono/cookie` |

### Authentication

| Express era | Hono era |
|---|---|
| `req.user` | `c.get("user")`, or `getUser(c)` / `requireUser(c)` from `@kahveciderin/concave` |
| `req.session` | `c.get("session")` or `getSession(c)` |
| `AuthenticatedRequest` type | removed — use Hono `Context` |
| `adapter.extractCredentials(req)` | `adapter.extractCredentials(c)` |
| `adapter.getRoutes(): Router` | `adapter.getRoutes(): Hono` |
| `onLogin(user, req)` etc. | `onLogin(user, c)` — callbacks receive the Hono Context |
| `cookie-parser` | not needed — cookies handled via `hono/cookie` |

`useAuth` still returns `{ router, middleware }`; mount with `app.route("/api/auth", router)` and `app.use("*", middleware)`, or pass it to `createConcave({ auth: { router, middleware } })`.

The middleware helpers (`requireAuth()`, `requireRole()`, `requirePermission()`) are now Hono `MiddlewareHandler`s and work the same way.

### Middleware

Rate limiting, idempotency, versioning, and observability middleware are Hono `MiddlewareHandler`s. Callbacks that received `req` now receive the Hono `Context`:

```typescript
createRateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  keyGenerator: (c) => c.get("user")?.id ?? getClientIP(c),  // was (req) => ...
  skip: (c) => c.req.path === "/healthz",
});
```

### Errors

Error classes (`NotFoundError`, `ValidationError`, ...) are unchanged in usage — `throw` them anywhere. They now extend Hono's `HTTPException` and self-render RFC 7807 `application/problem+json` responses. `errorHandler`/`notFoundHandler` (replacing `errorMiddleware`) add structured logging and request IDs.

### Other Routers

Everything that used to return an Express `Router` now returns `Hono`: `useAuth().router`, `createAdminUI()`, `createHealthEndpoints()`, `usePublicEnv()`, `useFileResource()`, `createConcaveRouter()`, and the OIDC provider router. Mount them all with `app.route(path, router)`.

## RSQL Scope Helper Changes

- `like(field, pattern)` now emits the valid `%=` operator (it previously emitted `=like=`, which the filter parser does not support).
- `notLike(field, pattern)` is new and emits `!%=`.
- `not(...)` was **removed** — the filter grammar has no NOT combinator. Use negated operators instead: `ne` (`!=`), `notIn` (`=out=`), `notLike` (`!%=`), `isNotNull` (`=isnull=false`).

## Client-Side Changes

The HTTP protocol is unchanged, so existing clients keep working. In the client library:

- `q.like` / `q.contains` / `q.startsWith` / `q.endsWith` now emit valid operators (`%=`, `=contains=`, `=startswith=`, `=endswith=`); `q.notLike`, `q.ilike`, and `q.icontains` were added.
- `q.not` was removed (no NOT combinator in the grammar) — use `q.neq`, `q.out`, `q.notLike`, `q.isNotNull`.
- Typegen now uses resource paths exactly as served, generates optional-aware `Input` types (fields with defaults, nullable fields, and primary keys are optional), and sanitizes identifiers.

## New Capabilities Worth Adopting

These shipped alongside the migration:

- **`createConcave()`** app factory with built-in error handling, health endpoints, OpenAPI, CORS, and chainable `.resource()` — see [Getting Started](./getting-started.md).
- **Cloudflare Workers** deployment and PostgreSQL support — see [Deployment](./deployment.md).
- **First-class ETags / optimistic locking** via the resource `etag` config — see [Resources](./resources.md#etag).
- **`npx concave create`** project scaffolder.
- **Server helpers** exported from the package root: `createSSEStream` / `formatSSE`, `readJsonBody`, `getClientIP`, `readEnv` / `isProduction` / `isDebugEnabled`.

## Migration Checklist

1. Replace `express()` with `createConcave()` (or `new Hono()` + `errorHandler`/`notFoundHandler`).
2. Change every `app.use(path, router)` to `app.route(path, router)`; change `app.use(mw)` to `app.use("*", mw)`.
3. Replace `app.listen` with `startServer` from `@kahveciderin/concave/node`.
4. Remove `express.json()`, `express.urlencoded()`, `cookie-parser`, and `asyncHandler` usage.
5. Rewrite custom routes to `(c) => Response` style using the table above.
6. Replace `req.user` with `getUser(c)` / `requireUser(c)`; update `useAuth` lifecycle hooks to `(user, c)`.
7. Update middleware `keyGenerator`/`skip`/`authenticate` callbacks to take `(c: Context)`.
8. Replace removed `not()` / `q.not` usages with negated operators.
9. Uninstall `express`, `cookie-parser`, and their `@types` packages.
