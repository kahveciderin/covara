# Database: internal tables, migrations, seeding & pooling

Covara's auth subsystem persists state in four framework-owned tables. Historically apps had to hand-roll these; the `covara/db` subpath now provides canonical schemas, an idempotent migrator, a generic seeder, and pool-sizing guidance.

## Internal tables

| Table | Purpose | Used by |
| --- | --- | --- |
| `auth_sessions` | Server-side sessions | `DrizzleSessionStore` (`src/auth/stores/drizzle.ts`) |
| `auth_accounts` | Linked OAuth/OIDC accounts | Auth.js / federated adapters |
| `auth_api_keys` | Hashed API keys | API-key credential flow |
| `auth_verification_tokens` | Email/magic-link/reset tokens | Verification flow |

### Schema contract

`auth_sessions`
- `id` TEXT PK
- `userId` TEXT NOT NULL (index `auth_session_userId_idx`)
- `createdAt` timestamp NOT NULL
- `expiresAt` timestamp NOT NULL (index `auth_session_expiresAt_idx`)
- `data` TEXT (JSON-encoded `SessionData.data`, nullable)

`auth_accounts`
- composite PK (`provider`, `providerAccountId`)
- `userId` TEXT NOT NULL (index `auth_account_userId_idx`)
- `type`, `provider`, `providerAccountId` TEXT NOT NULL
- `refresh_token`, `access_token`, `token_type`, `scope`, `id_token`, `session_state` TEXT
- `expires_at` integer (sqlite) / timestamp (postgres)

`auth_api_keys`
- `id` TEXT PK
- `userId` TEXT NOT NULL (index `auth_api_key_userId_idx`)
- `name`, `keyHash`, `keyPrefix` TEXT NOT NULL (index `auth_api_key_prefix_idx` on `keyPrefix`)
- `scopes` JSON (TEXT on sqlite, JSONB on postgres), nullable
- `createdAt` timestamp NOT NULL; `expiresAt`, `lastUsedAt`, `revokedAt` timestamp nullable

`auth_verification_tokens`
- composite PK (`identifier`, `token`)
- `identifier`, `token` TEXT NOT NULL
- `expires` timestamp NOT NULL

Timestamps are stored as Unix-epoch integers on SQLite (`{ mode: "timestamp" }`) and as `TIMESTAMP` on Postgres.

## Using the schemas

Spread the dialect-appropriate tables into your Drizzle schema so drizzle-kit and queries see them:

```typescript
import { internalSchema } from "covara/db";

export const schema = {
  ...internalSchema("sqlite"), // or "postgresql"
  // ...your own tables
};
```

Individual tables are also exported (`authSessions`, `authAccounts`, `authApiKeys`, `authVerificationTokens` default to the SQLite variants; `*Sqlite` / `*Pg` are explicit).

## Migrations

`migrateInternal(db, { dialect? })` runs `CREATE TABLE IF NOT EXISTS` (plus `CREATE INDEX IF NOT EXISTS`) for every internal table. It is idempotent and safe to call on every boot. The dialect is inferred from the Drizzle db when omitted.

```typescript
import { autoMigrate } from "covara/db";

await autoMigrate(db); // run once at startup
```

DDL is executed through the passed Drizzle db (`db.run` on libsql/D1, `db.execute` on postgres/pglite), so it is Workers-safe — no Node `fs` at runtime.

## Seeding

`seed(db, { tables })` (or the `createSeed()` builder) performs insert-or-ignore (`ON CONFLICT DO NOTHING`) so dev/staging data can be applied deterministically and repeatedly:

```typescript
import { createSeed } from "covara/db";

await createSeed()
  .table(usersTable, [{ id: "1", email: "demo@example.com" }])
  .run(db);
```

It is generic — works with any Drizzle table and a rows array, not just internal tables.

## Connection pooling

Use `recommendedPoolConfig(driver)` for sane defaults; tune to your origin's connection limit.

| Driver | `max` | Notes |
| --- | --- | --- |
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
const client = postgres(url, {
  max,
  idle_timeout: idleTimeoutMs / 1000,
  connect_timeout: connectTimeoutMs / 1000,
});
```
