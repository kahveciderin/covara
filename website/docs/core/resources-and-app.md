---
id: resources-and-app
title: Resources & the app factory
sidebar_label: Resources & the app factory
description: useResource and createCovara — the central abstraction that turns a Drizzle table into a full REST + real-time API, and every configuration option.
---

# Resources & the app factory

A **resource** is the core of Covara. Each resource maps to a Drizzle table and generates a complete Hono router: CRUD, batch operations, count, aggregations, subscriptions, search, and RPC. You create resources either with the `createCovara` factory or directly with `useResource`.

## `createCovara`

`createCovara(options)` returns a `CovaraApp` (which `extends Hono`) pre-wired with RFC 7807 [error handling](../tooling/error-handling.md), [security headers](../auth/security-headers.md), health endpoints, [OpenAPI](../tooling/openapi.md), and an optional [admin UI](../tooling/admin-ui.md). Resources are added with the chainable `.resource()`.

```typescript
import { createCovara } from "covara";

const app = createCovara({
  basePath: "/api",            // resource mount prefix (default: "/api")
  cors: true,                  // true | false | hono/cors options
  auth: { router, middleware },// the object returned by useAuth()
  middleware: [],              // extra Hono MiddlewareHandler[] applied to all routes
  observability: true,         // request/subscription metrics (or { metrics })
  health: true,                // /healthz + /readyz (default: true)
  adminUI: false,              // admin dashboard at /__covara/ui (default: false)
  openapi: true,               // OpenAPI document at /__covara (default: true)
})
  .resource(usersTable, { id: usersTable.id, db })             // → /api/users
  .resource("/people", usersTable, { id: usersTable.id, db }); // → /api/people
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `basePath` | `string` | `"/api"` | Prefix every resource is mounted under. |
| `cors` | `boolean \| CorsOptions` | `false` | Enable CORS, or pass a [hono/cors](https://hono.dev/docs/middleware/builtin/cors) config. |
| `auth` | `{ router, middleware }` | — | Result of [`useAuth`](../auth/overview.md); mounts auth routes and populates `c.get("user")`. |
| `middleware` | `MiddlewareHandler[]` | `[]` | Extra middleware applied before resources. |
| `observability` | `boolean \| { metrics }` | `false` | Collect request/subscription [metrics](../tooling/middleware.md). |
| `health` | `boolean \| HealthOptions` | `true` | Mount [`/healthz` and `/readyz`](../platform/health.md). |
| `adminUI` | `boolean \| AdminUIOptions` | `false` | Mount the [admin dashboard](../tooling/admin-ui.md). |
| `openapi` | `boolean \| OpenAPIOptions` | `true` | Serve the [OpenAPI spec](../tooling/openapi.md). |

The mount path is inferred from the table name unless you pass an explicit path as the first argument to `.resource()`.

### Serving the app

- **Node:** `await startServer(app, { port })` from `covara/node` — see [Node deployment](../deployment/node.md).
- **Cloudflare Workers:** `export default app` (or `app.fetch`) — see [Workers deployment](../deployment/workers.md).

## `useResource`

`useResource(table, config)` returns a plain `Hono` router. Use it when you want to compose routing yourself:

```typescript
import { Hono } from "hono";
import { useResource, errorHandler, notFoundHandler } from "covara";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.route("/api/posts", useResource(postsTable, { id: postsTable.id, db }));
```

`createCovara().resource()` is a thin wrapper over `useResource` that also registers the resource for OpenAPI, the admin UI, and cross-resource subscriptions.

## Configuration reference

### `id` (required)

The primary key column.

```typescript
{ id: postsTable.id }
```

### `db` (required)

The Drizzle database instance. Wrap it with [`trackMutations`](../realtime/mutation-tracking.md) if you want custom routes/procedures to feed subscriptions automatically.

```typescript
{ db }
```

### `auth`

Authorization scopes per operation. Each scope is a function of the current user returning an [RSQL](../auth/scopes.md) filter that is `AND`-combined with the request filter. See [Authorization scopes](../auth/scopes.md).

```typescript
{
  auth: {
    public: { read: true, subscribe: true }, // allow anonymous read/subscribe
    read: async (user) => rsql`*`,
    create: async (user) => (user ? rsql`*` : rsql``),
    update: async (user) => rsql`userId=="${user.id}"`,
    delete: async (user) => rsql`userId=="${user.id}"`,
    subscribe: async (user) => rsql`userId=="${user.id}"`,
  },
}
```

A scope function's return value decides **which rows** the operation may touch: `` rsql`*` `` allows everything, `` rsql`userId=="${user.id}"` `` restricts to matching rows (AND-combined with the request `?filter=`), and `` rsql`` `` (empty) denies entirely. Omit a scope to deny that operation for everyone except where `public` grants it.

#### `public` vs a scope returning `` rsql`*` ``

These look similar but act at different stages — `public` controls **who** (authenticated or not), while a scope function controls **which rows** an already-authenticated user sees:

- **`public`** is checked **first** and bypasses the auth requirement, so an **anonymous** request is allowed and resolves to all rows. Only `read` and `subscribe` can be made public (`public: true` is shorthand for both) — you cannot open `create`/`update`/`delete` this way.
- **A scope function returning `` rsql`*` ``** is only reached **after** the user check. An anonymous request gets a `401` (the function never runs); an authenticated user gets all rows. It means "any logged-in user can read everything, but you must be logged in."

| Config | Anonymous | Authenticated |
|--------|-----------|---------------|
| `public: { read: true }` | ✅ all rows | ✅ all rows |
| scope `read` returns `*` | ❌ `401` | ✅ all rows |
| both together | ✅ all rows | ✅ all rows |
| neither (omitted) | ❌ `401` | ❌ `403` |

For the common "public reads, owner-only writes" pattern you need **both** — set `public.read` *and* owner-scoped `create`/`update`/`delete` functions (this is exactly `scopePatterns.publicReadOwnerWrite`). See [Authorization scopes](../auth/scopes.md).

### `capabilities`

Enable/disable whole operations. All default to `true`. Reading, filtering, and sorting are always enabled.

```typescript
{
  capabilities: {
    enableCreate: true,
    enableUpdate: true,       // governs PATCH and PUT
    enableDelete: true,
    enableBatch: true,        // governs all /batch routes incl. /batch/upsert
    enableAggregations: true,
    enableSubscribe: true,
  },
}
```

### `fields`

Field-level policies. See [Fields: masking, writable, computed](./fields.md) for full behavior and security guarantees.

```typescript
{
  fields: {
    readable: ["id", "name", "email", "createdAt"], // allowlist; everything else stripped from responses
    writable: ["name", "email"],                     // enforced allowlist for create/update (mass-assignment protection)
    filterable: ["name", "email", "createdAt"],      // columns allowed in ?filter=
    sortable: ["name", "createdAt"],                  // columns allowed in ?orderBy=
  },
}
```

### `generatedFields`

Columns the server fills in (id, timestamps, ownership). They are exempt from `fields.writable` stripping (a hook can set them) and may be omitted from inbound bodies even with `strictInput`.

```typescript
{ generatedFields: ["id", "userId", "createdAt", "updatedAt"] }
```

### `strictInput`

By default unknown fields in a body are ignored. Set `strictInput: true` to reject them with a `422` (Zod strict mode).

```typescript
{ strictInput: true }
```

### `computed`

Virtual fields added to every response and subscription event, computed from the **full** (unmasked) row and never persisted. See [Fields](./fields.md#computed-fields).

```typescript
{
  computed: {
    fullName: (row) => `${row.firstName} ${row.lastName}`,
    isOverdue: (row) => row.dueAt != null && Date.parse(row.dueAt) < Date.now(),
  },
}
```

### `pagination`

```typescript
{ pagination: { defaultLimit: 20, maxLimit: 100 } }
```

See [Pagination](./pagination.md).

### `batch`

```typescript
{ batch: { create: 50, update: 50, replace: 50, delete: 10 } }
```

See [Batch operations](./batch.md).

### `etag`

Optimistic concurrency control. See [Optimistic locking](./optimistic-locking.md).

```typescript
{ etag: { versionField: "version" } } // or { updatedAtField: "updatedAt" }
```

### `softDelete`

Mark rows deleted instead of removing them. See [Soft delete](./soft-delete.md).

```typescript
{ softDelete: { field: "deletedAt" } }
```

### `relations`

Declare `belongsTo` / `hasOne` / `hasMany` / `manyToMany` relations loadable via `?include=`. See [Relations](./relations.md).

### `nestedWrites`

Enable write-through of embedded relation objects in `POST` bodies (requires `relations`). See [Nested writes](./nested-writes.md).

```typescript
{ nestedWrites: true }
```

### `search`

Register searchable fields for the `GET /search` endpoint. See [Search](./search.md).

```typescript
{ search: { enabled: true, fields: { title: { weight: 2 }, body: {} } } }
```

### `rateLimit`

Per-resource rate limiting. See [Middleware](../tooling/middleware.md#rate-limiting).

```typescript
{ rateLimit: { windowMs: 60_000, maxRequests: 100 } }
```

### `customOperators`

Add filter operators. See [Filtering → Custom operators](./filtering.md#custom-operators).

### `hooks`

Lifecycle hooks around every mutation. See [Procedures & hooks](./procedures.md).

```typescript
{
  hooks: {
    onBeforeCreate: async (ctx, data) => ({ ...data, createdAt: new Date() }),
    onAfterCreate: async (ctx, created) => {},
    onBeforeUpdate: async (ctx, id, data) => ({ ...data, updatedAt: new Date() }),
    onAfterUpdate: async (ctx, updated) => {},
    onBeforeDelete: async (ctx, id) => {},
    onAfterDelete: async (ctx, deleted) => {},
  },
}
```

### `procedures`

Custom Zod-validated RPC endpoints at `POST /rpc/:name`. See [Procedures](./procedures.md#rpc-procedures).

## Generated endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | [List](./crud.md) with pagination, filtering, ordering, projections |
| `GET` | `/:id` | Get one |
| `POST` | `/` | Create |
| `PATCH` | `/:id` | Partial update |
| `PUT` | `/:id` | Full replace |
| `DELETE` | `/:id` | Delete (or soft delete) |
| `GET` | `/count` | [Count](./crud.md#counting) |
| `GET` | `/aggregate` | [Aggregations](./aggregations.md) |
| `GET` | `/aggregate/subscribe` | [Live aggregation](../realtime/aggregate-subscriptions.md) |
| `GET` | `/subscribe` | [SSE subscription](../realtime/subscriptions.md) |
| `GET` | `/search` | [Full-text search](./search.md) (when configured) |
| `POST` | `/batch` | [Batch create](./batch.md) |
| `PATCH` | `/batch` | Batch update |
| `DELETE` | `/batch` | Batch delete |
| `POST` | `/batch/upsert` | [Bulk insert-or-update](./batch.md#bulk-upsert) |
| `POST` | `/rpc/:name` | [RPC procedures](./procedures.md) |

## Query parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `filter` | [Filter expression](./filtering.md) | `status=="active"` |
| `select` | Field projection | `id,name,email` |
| `include` | [Load relations](./relations.md) | `category,tags(limit:5)` |
| `cursor` | [Pagination cursor](./pagination.md) | `eyJpZCI6MTB9` |
| `limit` | Page size | `20` |
| `orderBy` | Sort order | `name:asc,age:desc` |
| `totalCount` | Include total count | `true` |
| `having` | Filter aggregate groups (`/aggregate`) | `count>=5;sum_total>100` |
| `withDeleted` | Include [soft-deleted](./soft-delete.md) rows | `true` |

## Related

- [CRUD endpoints](./crud.md) · [Filtering](./filtering.md) · [Pagination](./pagination.md) · [Aggregations](./aggregations.md)
- [Relations](./relations.md) · [Procedures & hooks](./procedures.md) · [Mutation tracking](../realtime/mutation-tracking.md)
- [Authorization scopes](../auth/scopes.md) · [Secure queries](../auth/secure-queries.md)
