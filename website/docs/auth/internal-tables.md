---
id: internal-tables
title: Internal & system tables
sidebar_label: Internal tables
description: Every table Covara's auth/system layer reads or writes, the columns each one requires, which are framework-owned vs app-supplied, and how to bring your own tables or remap their columns with defineInternalSchema.
---

# Internal & system tables

Covara's auth and system features touch a handful of tables. This page lists **every one of them**, what columns each requires, who reads/writes it, and how to point Covara at your own schema — including renaming tables and **remapping column names**.

There are three categories:

- **Framework-owned SQL tables** — `auth_sessions`, `auth_accounts`, `auth_api_keys`, `auth_verification_tokens`. Covara ships their schema and (optionally) migrates them. You can rename them and remap their columns.
- **App-supplied tables** — your **users** table and (if you use file uploads) a **files** table. Covara never owns these; it reaches them through callbacks/resources you provide. You only need to satisfy a required shape.
- **Not database tables** — the **changelog** and **rate limits** are backed by the [KV store](../platform/kv.md) (or memory), *not* DB tables. The example app defines `changelog`/`rate_limits` tables for illustration, but the framework does not read them.

## Framework-owned SQL tables

Built-in definitions live in `internal-schema.ts` (exported as `authSessions`, `authAccounts`, `authApiKeys`, `authVerificationTokens`, and the dialect-specific `…Sqlite`/`…Pg` variants). Only **`auth_sessions`** is read column-by-column at runtime today (by the Drizzle session store); the others are reached through stores/adapters or only created by migration.

### `auth_sessions`

Session storage. Read/written by the [Drizzle session store](./sessions.md) — the one table queried by column directly.

| Logical key | Required | Purpose |
|---|---|---|
| `id` | ✅ | session id (primary key) |
| `userId` | ✅ | owning user |
| `createdAt` | ✅ | creation time |
| `expiresAt` | ✅ | expiry (indexed) |
| `data` | optional | JSON blob (e.g. `lastActiveAt`) |

### `auth_accounts`

OAuth/OIDC linked accounts. Persisted by your OIDC/Auth.js **adapter callbacks** — Covara has no direct store for it; the schema exists for migration + reference. Compound primary key on `(provider, providerAccountId)`.

Required: `userId`, `type`, `provider`, `providerAccountId`. Optional token columns: `refresh_token`, `access_token`, `expires_at`, `token_type`, `scope`, `id_token`, `session_state`.

### `auth_api_keys`

API keys. Reached through the [`ApiKeyStore`](./api-keys.md) interface.

Required: `id`, `userId`, `name`, `keyHash`, `keyPrefix`, `createdAt`. Optional: `scopes` (JSON), `expiresAt`, `lastUsedAt`, `revokedAt`.

### `auth_verification_tokens`

Email-verification / password-reset / magic-link tokens. Reached through the `VerificationTokenStore` interface. Compound primary key on `(identifier, token)`.

Required: `identifier`, `token`, `expires`.

## Bringing your own tables (and remapping columns)

Use `defineInternalSchema(...)` to point Covara at your own Drizzle tables. Each table accepts a `fieldMap` that maps Covara's **logical keys** to the **property names** on your table — so a schema with Auth.js-style or snake_case columns works unchanged.

```typescript
import { defineInternalSchema, createDrizzleSessionStore, createPassportAdapter } from "covara";
import { mySessions } from "./schema";

const internal = defineInternalSchema({
  dialect: "sqlite",
  sessions: {
    table: mySessions,           // any table name
    fieldMap: {                  // logical key -> your column property
      userId: "user_id",
      createdAt: "created_at",
      expiresAt: "expires",
      data: "blob",
    },
  },
});

// Build the session store with the resolved table, then pass the bundle to
// createCovara for migration/introspection.
const adapter = createPassportAdapter({
  getUserById,
  sessionStore: createDrizzleSessionStore({ db, resolver: internal.sessions }),
});

const app = createCovara({ internalSchema: internal, auth: useAuth({ adapter }) });
```

- `defineInternalSchema` **validates required keys at startup** and throws a precise error (e.g. `internalSchema.sessions.expiresAt: required column not found…`) if a required column is missing — fail-fast, never at query time.
- Omitting a table override falls back to the built-in table, so today's behavior is unchanged when you pass nothing.
- `createCovara({ internalSchema })` records the bundle for migration + introspection. It does **not** rewire already-constructed stores — build `createDrizzleSessionStore({ resolver })` yourself (as above).
- The `SessionData` shape your app sees stays in logical keys (`id`/`userId`/`createdAt`/`expiresAt`/`data`); remapping happens only at the SQL boundary.

### The KV session store works with any backend

`createKVSessionStore({ kv })` is backed by the [KV abstraction](../platform/kv.md), so sessions can live in Redis, the Cloudflare Durable Object store, or in-memory for tests — its internal hash fields are a private serialization and are **not** subject to `fieldMap`. (`createRedisSessionStore` remains as a deprecated alias.)

## Migrations

`migrateInternal(db, { schema?, dialect? })` has three modes:

1. **No `schema`** → creates the built-in tables with the canonical DDL (indexes + compound PKs). This is the default and is byte-for-byte unchanged.
2. **`schema.managedExternally = true`** → **no-op**. Recommended whenever you customize tables: create them with your own tool (e.g. `drizzle-kit`), which handles indexes and compound primary keys correctly.
3. **`schema` without `managedExternally`** → generates `CREATE TABLE IF NOT EXISTS` for overridden tables from the Drizzle table objects. Single-primary-key tables only — it **throws** for compound-PK tables (`auth_accounts`, `auth_verification_tokens`), directing you to mode 2. Indexes are not regenerated in this mode.

## App-supplied tables

### Users

Covara **never owns a users table**. Auth adapters reach the user through a `getUserById(id)` callback you implement, so you can store users however you like (a Drizzle table, an external service, anything). The object you return must include:

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | string |
| `email` | optional | |
| `name` | optional | |
| `image` | optional | |
| `emailVerified` | optional | `Date \| null` |
| `metadata` | optional | arbitrary record |

### Files

If you use [file uploads](../platform/storage.md) via `fileResource`, you supply the files table. Required columns: `id`, `filename`, `mimeType`, `size`, `storagePath`, `status` (`"pending" | "completed"`), `createdAt`. Optional: `userId` (for access control), `url`.

## Changelog & rate limits are not DB tables

The [changelog](../realtime/changelog.md) is stored in the [KV store](../platform/kv.md) (sorted set) with an in-memory fallback. [Rate limiting](../tooling/middleware.md) uses the KV store or an in-memory map. **Neither reads a database table.** If you saw `changelog`/`rate_limits` tables in an example schema, they are illustrative only — Covara does not populate or query them.

## Related

- [Sessions](./sessions.md) · [API keys](./api-keys.md) · [KV store](../platform/kv.md)
- [Auth contract](../contracts/auth.md)
