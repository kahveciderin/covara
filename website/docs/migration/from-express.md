---
id: from-express
title: Migrating from Express
sidebar_label: From Express
description: Upgrade from the Express-era Covara to the Hono-based version — the HTTP API is unchanged; only server setup and custom-route code differ.
---

# Migrating from Express

Covara moved from Express to [Hono](https://hono.dev). The **HTTP API is unchanged** — same endpoints, payloads, status codes, headers, and query parameters — so API consumers and the [client library](../client/overview.md) need no changes. Only server setup code does.

Why: Hono runs on Node **and** [Cloudflare Workers](../deployment/workers.md), has first-class TypeScript types, and drops the `express`/`cookie-parser` dependencies.

## App setup

**Before (Express):**

```typescript
import express from "express";
import { useResource, errorMiddleware } from "covara";

const app = express();
app.use(express.json());
app.use("/api/todos", useResource(todosTable, { id: todosTable.id, db }));
app.use(errorMiddleware);
app.listen(3000);
```

**After (Hono):**

```typescript
import { createCovara } from "covara";
import { startServer } from "covara/node";

const app = createCovara({ cors: true }).resource(todosTable, { id: todosTable.id, db });
await startServer(app, { port: 3000 });
```

- `useResource` now returns a `Hono` router — mount with `app.route(path, router)`, **not** `app.use(path, router)`.
- Body parsing is built in (`express.json()`/`urlencoded()` gone).
- `app.listen` → `startServer` (Node) or export the app as a Worker handler (see [Deployment](../deployment/node.md)).

## Routers & mounting

| Express era | Hono era |
|-------------|----------|
| `express()` | `createCovara(options)` or `new Hono()` |
| `app.use("/path", router)` | `app.route("/path", router)` |
| `app.use(middleware)` | `app.use("*", middleware)` |
| `app.listen(port)` | `await startServer(app, { port })` from `covara/node` |
| `asyncHandler(fn)` | removed — just `throw` errors |
| `errorMiddleware` | `app.onError(errorHandler)` + `app.notFound(notFoundHandler)` (automatic with `createCovara`) |
| `next(error)` | `throw error` |

## Request / response in custom routes

Handlers receive a Hono `Context` (`c`) and **return** a `Response`:

| Express | Hono |
|---------|------|
| `req.params.id` | `c.req.param("id")` |
| `req.query.foo` | `c.req.query("foo")` |
| `req.body` | `await c.req.json()` |
| `req.headers["x-foo"]` | `c.req.header("x-foo")` |
| `req.cookies.foo` | `getCookie(c, "foo")` from `hono/cookie` |
| `req.ip` | `getClientIP(c)` from `covara` |
| `res.json(x)` | `return c.json(x)` |
| `res.status(201).json(x)` | `return c.json(x, 201)` |
| `res.status(204).end()` | `return c.body(null, 204)` |
| `res.redirect(url)` | `return c.redirect(url)` |
| `res.setHeader(k, v)` | `c.header(k, v)` (before returning) |
| `res.cookie(k, v, o)` | `setCookie(c, k, v, o)` from `hono/cookie` |

## Authentication

| Express era | Hono era |
|-------------|----------|
| `req.user` | `c.get("user")` / `getUser(c)` / `requireUser(c)` |
| `req.session` | `c.get("session")` / `getSession(c)` |
| `AuthenticatedRequest` type | removed — use Hono `Context` |
| `adapter.getRoutes(): Router` | `adapter.getRoutes(): Hono` |
| `onLogin(user, req)` | `onLogin(user, c)` |
| `cookie-parser` | not needed — `hono/cookie` |

`useAuth` still returns `{ router, middleware }`. `requireAuth()`/`requireRole()`/`requirePermission()` are now Hono middleware.

## Middleware

Callbacks that received `req` now receive the Hono `Context`:

```typescript
createRateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  keyGenerator: (c) => c.get("user")?.id ?? getClientIP(c), // was (req) => ...
  skip: (c) => c.req.path === "/healthz",
});
```

## RSQL scope helper changes

- `like(field, pattern)` now emits the valid `%=` operator (was `=like=`, unsupported by the parser).
- `notLike(field, pattern)` is new (`!%=`).
- `not(...)` was **removed** — no NOT combinator in the grammar. Use `ne` (`!=`), `notIn` (`=out=`), `notLike` (`!%=`), `isNotNull` (`=isnull=false`).

## Client-side changes

The protocol is unchanged, so clients keep working. In the [client library](../client/queries.md):

- `q.like`/`q.contains`/`q.startsWith`/`q.endsWith` now emit valid operators; `q.notLike`/`q.ilike`/`q.icontains` were added.
- `q.not` was removed — use `q.neq`/`q.out`/`q.notLike`/`q.isNotNull`.
- [Typegen](../client/typegen.md) uses resource paths as served and generates optional-aware `Input` types.

## Worth adopting

[`createCovara()`](../core/resources-and-app.md), [Cloudflare Workers + PostgreSQL](../deployment/workers.md), [ETags/optimistic locking](../core/optimistic-locking.md), [`npx covara create`](../tooling/cli.md), and server helpers (`createSSEStream`, `readJsonBody`, `getClientIP`, `readEnv`/`isProduction`/`isDebugEnabled`).

## Checklist

1. `express()` → `createCovara()` (or `new Hono()` + handlers).
2. `app.use(path, router)` → `app.route(path, router)`; `app.use(mw)` → `app.use("*", mw)`.
3. `app.listen` → `startServer` from `covara/node`.
4. Remove `express.json()`/`urlencoded()`, `cookie-parser`, `asyncHandler`.
5. Rewrite custom routes to `(c) => Response`.
6. `req.user` → `getUser(c)`/`requireUser(c)`; lifecycle hooks to `(user, c)`.
7. Update middleware callbacks to `(c: Context)`.
8. Replace `not()`/`q.not` with negated operators.
9. Uninstall `express`, `cookie-parser`, and their `@types`.

## Related

- [Resources](../core/resources-and-app.md) · [Node deployment](../deployment/node.md) · [Error handling](../tooling/error-handling.md)
