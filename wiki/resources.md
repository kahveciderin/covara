# Resources

Resources are the core of Covara. Each resource maps to a database table and automatically generates REST endpoints.

## Basic Usage

```typescript
import { useResource } from "covara";
import { postsTable } from "./db/schema";
import { db } from "./db/db";

app.route("/posts", useResource(postsTable, {
  id: postsTable.id,
  db,
}));
```

`useResource` returns a `Hono` router — mount it on any Hono app with `app.route(path, router)`, or use the `createCovara` factory's chainable helper:

```typescript
const app = createCovara()
  .resource(postsTable, { id: postsTable.id, db })          // mounts at /api/posts
  .resource("/articles", postsTable, { id: postsTable.id, db });  // custom path
```

## Configuration Options

### `id` (required)

The primary key column for the resource:

```typescript
{
  id: postsTable.id,
}
```

### `db` (required)

The Drizzle database instance:

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./data.db" });
const db = drizzle(client);

{
  db,
}
```

### `batch`

Limits for batch operations:

```typescript
{
  batch: {
    create: 50,   // Max items per batch create
    update: 50,   // Max items per batch update
    replace: 50,  // Max items per batch replace
    delete: 10,   // Max items per batch delete
  },
}
```

### `pagination`

Pagination settings:

```typescript
{
  pagination: {
    defaultLimit: 20,  // Default page size
    maxLimit: 100,     // Maximum page size
  },
}
```

### `rateLimit`

Rate limiting configuration:

```typescript
{
  rateLimit: {
    windowMs: 60000,    // Time window (1 minute)
    maxRequests: 100,   // Max requests per window
  },
}
```

### `etag`

ETags and optimistic concurrency control:

```typescript
{
  etag: {
    versionField: "version",      // Integer column; auto-incremented on every update
    // updatedAtField: "updatedAt",  // Alternative: timestamp-based tags (default)
    // idField: "id",                // Combined with updatedAtField (default: "id")
    // algorithm: "weak",            // "weak" (default) or "strong"
  },
}
```

When enabled, `POST /`, `GET /:id`, `PATCH /:id`, and `PUT /:id` responses carry an `ETag` header; `If-Match` is enforced on `PATCH`/`PUT`/`DELETE` (mismatch returns `412 Precondition Failed`, `If-Match: *` always matches); and `If-None-Match` on `GET /:id` returns `304 Not Modified` when current. See the [ETag contract](../contracts/etag.md).

### `softDelete`

Opt-in soft deletes. Instead of removing rows, `DELETE` marks them by setting a column:

```typescript
{
  softDelete: {
    field: "deletedAt",            // Column used as the deletion marker
    // deletedValue: () => Date.now(),  // Optional; defaults to current ISO timestamp
  },
}
```

A row is considered deleted when the `field` column is non-null. Behavior:

- `DELETE /:id` sets the marker column instead of deleting the row, and still returns `204`.
- Subscribers receive a `removed` event, because the row leaves the (not-deleted) read scope.
- `GET /`, `GET /:id`, `GET /count`, `GET /aggregate`, and subscription snapshots exclude
  soft-deleted rows. To include them, pass `?withDeleted=true`.
- Re-deleting an already soft-deleted row returns `404` (it is invisible to the delete scope).
- Use `deletedValue` for non-timestamp columns, e.g. `() => Date.now()` for an integer column
  or `() => 1` for a boolean flag. The column is considered "deleted" whenever it is non-null.

### `nestedWrites`

Enable write-through of embedded relation objects in `POST` bodies. Off by default; requires
`relations` to be configured. See [Relations](./relations.md#nested-write-through-mutations).

```typescript
{
  nestedWrites: true,
}
```

### `auth`

Authentication and authorization scopes:

```typescript
{
  auth: {
    // Public access settings
    public: {
      read: true,
      subscribe: true,
    },

    // Scope functions return filter expressions
    read: async (user) => rsql`*`,
    create: async (user) => rsql`*`,
    update: async (user) => rsql`userId=="${user.id}"`,
    delete: async (user) => rsql`userId=="${user.id}"`,
    subscribe: async (user) => rsql`*`,
  },
}
```

### `capabilities`

Enable or disable specific operations:

```typescript
{
  capabilities: {
    enableCreate: true,       // Allow POST /
    enableUpdate: true,       // Allow PATCH /:id and PUT /:id
    enableDelete: true,       // Allow DELETE /:id
    enableBatch: true,        // Allow all batch operations (POST/PATCH/DELETE /batch, POST /batch/upsert)
    enableAggregations: true, // Allow GET /aggregate
    enableSubscribe: true,    // Allow GET /subscribe
  },
}
```

All capabilities default to `true`. Reading, filtering, and sorting are always enabled and are not
gated by a capability. `PUT /:id` (full replace) is governed by `enableUpdate` — there is no separate
replace capability. `enableBatch` is the single gate for every batch operation, including
`POST /batch/upsert`.

### `fields`

Field-level policies for read/write/filter/sort access:

```typescript
{
  fields: {
    readable: ["id", "name", "email", "createdAt"],  // Allowlist of columns returned in responses
    writable: ["name", "email"],                      // Fields allowed in create/update
    filterable: ["name", "email", "createdAt"],       // Fields allowed in filters
    sortable: ["name", "createdAt"],                  // Fields allowed in orderBy
  },
}
```

#### Field-level read masking

When `fields.readable` is set, it acts as an **allowlist of table columns** that may leave the
server. Any column not in the list is stripped from every response — list, get, create, update,
batch, and search — as well as from every subscription event (`existing`, `added`, `changed`)
and the initial subscription snapshot. The mask is applied server-side, so a client **cannot**
recover a hidden column via `?select=` or by subscribing.

```typescript
{
  fields: {
    // `passwordHash`, `internalNotes`, etc. are never returned, no matter
    // what the client requests.
    readable: ["id", "name", "email", "createdAt"],
  },
}
```

Only table columns are masked. Relation keys (loaded via `?include=`), computed values, and
internal markers such as `_etag`/`_optimisticId` always pass through, so includes keep working.
See the [Authentication contract](../contracts/auth.md) for the security guarantee.

#### Field-level write enforcement (mass-assignment protection)

When `fields.writable` is set, it is an **enforced allowlist** of table columns a client may set on
create and update. Any table column not in the list is silently stripped from the incoming body
before it reaches lifecycle hooks or the database — on `POST /`, `PATCH /:id`, `PUT /:id`,
`POST /batch`, `PATCH /batch`, and `POST /batch/upsert`.

> **Behavior change:** `fields.writable` used to be advisory. It is now enforced, so a malicious
> client can no longer set protected columns (e.g. `role`, `isAdmin`, `ownerId`) by smuggling them
> into a request body.

Exemptions:

- The **primary key** (`id`) is never stripped.
- Columns listed in `generatedFields` are never stripped (they are server-managed but may flow
  through).
- Non-column keys (relation payloads for nested writes, etc.) always pass through — only real table
  columns are subject to the allowlist.

Stripping happens **before** lifecycle hooks run, so a server-side `onBeforeCreate`/`onBeforeUpdate`
hook can still set a protected field itself. See the [Authentication contract](../contracts/auth.md)
and [Secure Queries](./secure-queries.md#field-level-write-enforcement) for the guarantee.

### `strictInput`

By default, unknown fields in a create/update body are silently ignored. Set `strictInput: true` to
reject them instead — the request fails with a `422` validation error (Zod strict mode) if the body
contains any field that is not a known column:

```typescript
{
  strictInput: true,
}
```

`generatedFields` remain optional (they may be omitted) but unknown fields are still rejected.
Combine with `fields.writable` for both rejection of unknown fields and stripping of known-but-not-
writable columns.

### `computed`

Virtual fields added to every response and every subscription event. Each function receives the
**full row** (before read masking) and returns a value that is attached under the given key:

```typescript
{
  computed: {
    fullName: (row) => `${row.firstName} ${row.lastName}`,
    isOverdue: (row) => row.dueAt != null && Date.parse(row.dueAt as string) < Date.now(),
  },
}
```

Computed fields:

- Are added to list, get, create, update, batch, and search responses, plus every subscription
  event (`existing`, `added`, `changed`) and the initial snapshot.
- Are computed from the full, unmasked row, so they can derive from columns that `fields.readable`
  hides.
- Are **exempt from read masking** — because they are not table columns, the `fields.readable`
  allowlist never strips them.
- Are not persisted to the database.

### `customOperators`

Custom filter operators:

```typescript
{
  customOperators: {
    "=contains=": {
      convert: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
      execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
    },
  },
}
```

### `hooks`

Lifecycle hooks:

```typescript
{
  hooks: {
    onBeforeCreate: async (ctx, data) => {
      return { ...data, createdAt: new Date() };
    },
    onAfterCreate: async (ctx, created) => {
      console.log("Created:", created.id);
    },
    onBeforeUpdate: async (ctx, id, data) => {
      return { ...data, updatedAt: new Date() };
    },
    onAfterUpdate: async (ctx, updated) => {},
    onBeforeDelete: async (ctx, id) => {},
    onAfterDelete: async (ctx, deleted) => {},
  },
}
```

### `procedures`

RPC procedures:

```typescript
{
  procedures: {
    publish: defineProcedure({
      input: z.object({ id: z.string() }),
      output: z.object({ success: z.boolean() }),
      handler: async (ctx, input) => {
        // Use tracked db for automatic subscription updates
        await db.update(postsTable)
          .set({ published: true })
          .where(eq(postsTable.id, input.id))
          .returning();
        return { success: true };
      },
    }),
  },
}
```

For mutations inside procedures to automatically notify subscribers, use a database wrapped with `trackMutations`. See [Mutation Tracking](./track-mutations.md) for details.

## Bulk Upsert

`POST /batch/upsert` inserts or updates a list of items keyed by their primary key in a single
transaction. It uses the same request shape as batch create (`{ "items": [...] }`) and is bounded by
the `batch.create` limit. It requires both `create` and `update` scope and the `enableBatch`
capability.

```http
POST /api/posts/batch/upsert
Content-Type: application/json

{
  "items": [
    { "id": "p1", "title": "Existing post, updated" },
    { "id": "p2", "title": "Brand new post" }
  ]
}
```

For each item:

- If a row with that primary key already exists, it runs the **update** lifecycle hooks
  (`onBeforeUpdate`/`onAfterUpdate`) and emits a `changed` subscription event.
- If no row exists, it runs the **create** lifecycle hooks (`onBeforeCreate`/`onAfterCreate`) and
  emits an `added` subscription event.

`fields.writable` enforcement applies to every item. The response is `{ "items": [...] }` with the
upserted rows (read-masked and with computed fields applied).

## Generated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List with pagination |
| GET | `/:id` | Get single item |
| POST | `/` | Create item |
| PATCH | `/:id` | Partial update |
| PUT | `/:id` | Full replace |
| DELETE | `/:id` | Delete item |
| GET | `/count` | Count items |
| GET | `/aggregate` | Aggregation queries |
| GET | `/subscribe` | SSE subscription |
| POST | `/batch` | Batch create |
| PATCH | `/batch` | Batch update |
| DELETE | `/batch` | Batch delete |
| POST | `/batch/upsert` | Bulk insert-or-update by primary key |
| POST | `/rpc/:name` | RPC procedures |

## Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `filter` | Filter expression | `status=="active"` |
| `select` | Field projection | `id,name,email` |
| `cursor` | Pagination cursor | `eyJpZCI6MTB9` |
| `limit` | Page size | `20` |
| `orderBy` | Sort order | `name:asc,age:desc` |
| `totalCount` | Include total count | `true` |
| `having` | Filter aggregate groups (`/aggregate` only) | `count>=5;sum_total>100` |
| `withDeleted` | Include soft-deleted rows (when `softDelete` is set) | `true` |

## Related

- [Filtering](./filtering.md) - Learn about filter syntax and custom operators
- [Pagination](./pagination.md) - Cursor-based pagination details
- [Aggregations](./aggregations.md) - Statistical queries and grouping
- [Subscriptions](./subscriptions.md) - Real-time event streaming
- [Procedures & Hooks](./procedures.md) - RPC and lifecycle hooks
- [Mutation Tracking](./track-mutations.md) - Automatic changelog and cache invalidation
- [Authentication](./authentication.md) - Auth setup and authorization scopes
