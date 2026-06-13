---
id: databases
title: Database matrix
sidebar_label: Databases
description: Every Drizzle-supported SQLite and PostgreSQL driver Covara runs on — libsql, better-sqlite3, D1, postgres-js, Neon, PGlite — across Node and Workers.
---

# Database matrix

Everything goes through [Drizzle ORM](https://orm.drizzle.team), so any Drizzle-supported driver works. Tested combinations:

| Database | Driver | Runtime | Notes |
|----------|--------|---------|-------|
| SQLite | `@libsql/client` (`drizzle-orm/libsql`) | Node | Local file or [Turso](https://turso.tech) |
| SQLite | `better-sqlite3` (`drizzle-orm/better-sqlite3`) | Node | Synchronous, fast local |
| SQLite | D1 (`drizzle-orm/d1`) | Workers | Native Cloudflare binding |
| PostgreSQL | `postgres` (`drizzle-orm/postgres-js`) | Node + Workers | Use [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) on Workers |
| PostgreSQL | `@neondatabase/serverless` (`drizzle-orm/neon-http`) | Node + Workers | HTTP driver, edge-friendly |
| PostgreSQL | `@electric-sql/pglite` (`drizzle-orm/pglite`) | Node | Embedded Postgres, great for tests |

## Examples

```typescript
// libsql (local file or Turso)
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
const db = drizzle(createClient({ url: "file:./data.db" }));

// better-sqlite3
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
const db = drizzle(new Database("data.db"));

// D1 (Workers)
import { drizzle } from "drizzle-orm/d1";
const db = drizzle(env.DB);

// postgres-js
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
const db = drizzle(postgres(process.env.DATABASE_URL!));

// Neon (HTTP, edge-friendly)
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
const db = drizzle(neon(process.env.DATABASE_URL!));

// PGlite (embedded, tests)
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
const db = drizzle(new PGlite());
```

Pass whichever `db` you build to `useResource`/`createCovara` — or wrap it with [`trackMutations`](../realtime/mutation-tracking.md) first if you have custom routes.

## Migrations

Covara doesn't impose a migration tool — use [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview):

```bash
npx drizzle-kit generate   # generate migration SQL from your schema
npx drizzle-kit push       # push schema directly (dev)
```

On D1, apply migrations via wrangler — see [Workers deployment](./workers.md).

## Internal tables (`covara/db`)

The auth subsystem persists state in four framework-owned tables. The `covara/db` subpath provides canonical schemas, an idempotent migrator, a generic seeder, and pool-sizing guidance.

| Table | Purpose | Used by |
|-------|---------|---------|
| `auth_sessions` | Server-side [sessions](../auth/sessions.md) | `DrizzleSessionStore` |
| `auth_accounts` | Linked OAuth/OIDC accounts | Auth.js / [federated](../auth/federated.md) adapters |
| `auth_api_keys` | Hashed [API keys](../auth/api-keys.md) | API-key credential flow |
| `auth_verification_tokens` | Email/magic-link/reset tokens | [Verification flows](../auth/account-security.md) |

Timestamps are stored as Unix-epoch integers on SQLite (`{ mode: "timestamp" }`) and as `TIMESTAMP` on Postgres.

Spread the dialect-appropriate tables into your Drizzle schema so drizzle-kit and queries see them:

```typescript
import { internalSchema } from "covara/db";

export const schema = {
  ...internalSchema("sqlite"), // or "postgresql"
  // ...your own tables
};
```

Individual tables are exported too (`authSessions`, `authAccounts`, `authApiKeys`, `authVerificationTokens` default to SQLite; `*Sqlite` / `*Pg` are explicit).

## Framework migrations

`migrateInternal(db, { dialect? })` runs `CREATE TABLE IF NOT EXISTS` (+ `CREATE INDEX IF NOT EXISTS`) for every internal table — idempotent and safe to call on every boot. `autoMigrate(db)` is the convenience wrapper; the dialect is inferred from the Drizzle db.

```typescript
import { autoMigrate } from "covara/db";
await autoMigrate(db); // run once at startup
```

DDL runs through the passed Drizzle db (`db.run` on libsql/D1, `db.execute` on postgres/pglite), so it's Workers-safe — no Node `fs` at runtime.

## Seeding

`seed(db, { tables })` / `createSeed()` performs insert-or-ignore (`ON CONFLICT DO NOTHING`), so dev/staging data applies deterministically and repeatably. It works with any Drizzle table.

```typescript
import { createSeed } from "covara/db";

await createSeed()
  .table(usersTable, [{ id: "1", email: "demo@example.com" }])
  .run(db);
```

## Connection pooling

Use `recommendedPoolConfig(driver)` for sane defaults; tune to your origin's connection limit.

| Driver | `max` | Notes |
|--------|-------|-------|
| `postgres-js` | 10 | Long-lived Node process; keep `max` below (DB limit ÷ instances). Use a pooler URL for serverless. |
| `neon` | 1 | Serverless HTTP driver is connectionless per request; use the `-pooler` endpoint. |
| `pglite` | 1 | Embedded single-connection engine; pooling N/A. |
| `libsql` | 1 | HTTP/WS client multiplexes over one connection. |
| `d1` | 1 | Request-scoped binding; avoid long transactions. |
| `hyperdrive` | 5 | Hyperdrive pools at the edge; keep the Worker-side `max` small. |

```typescript
import { recommendedPoolConfig } from "covara/db";
import postgres from "postgres";

const { max, idleTimeoutMs, connectTimeoutMs } = recommendedPoolConfig("postgres-js");
const client = postgres(url, { max, idle_timeout: idleTimeoutMs / 1000, connect_timeout: connectTimeoutMs / 1000 });
```

## Search indexes

The built-in [search](../core/search.md) adapters create their own backing tables — SQLite FTS5 or Postgres `tsvector` — so full-text search needs no extra service on either database.

## Related

- [Node deployment](./node.md) · [Cloudflare Workers](./workers.md) · [Search](../core/search.md)
