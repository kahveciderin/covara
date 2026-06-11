# Deployment

Concave is built on Hono, so the same app runs standalone on Node.js and on Cloudflare Workers. The fastest way to get a deployable project is the CLI:

```bash
npx concave create my-app --template node --db sqlite
npx concave create my-app --template cloudflare --db postgres
```

Generated projects are deploy-ready. Alongside your source and schema, the scaffolder
writes:

- `Dockerfile` and `docker-compose.yml` (app + Redis, plus a Postgres service when `--db postgres`) for Node deployments, with a `.dockerignore`.
- A complete `wrangler.toml` for the Cloudflare template — `nodejs_compat`, a `[[d1_databases]]` binding, a commented `[[kv_namespaces]]` block, and the `ConcaveKVDurableObject` Durable Object binding + migration.
- A GitHub Actions CI workflow (`.github/workflows/ci.yml`) that installs, lints, tests, and builds.
- `.env.example` documenting the environment variables the app expects.

Inside an existing project you can scaffold incrementally:

```bash
npx concave generate resource invoices   # writes a Drizzle table + a registration snippet
npx concave generate migration           # runs drizzle-kit generate (pass -- to forward args)
```

## Standalone Node.js

Use `startServer` from `@kahveciderin/concave/node` (wraps `@hono/node-server`):

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createConcave } from "@kahveciderin/concave";
import { startServer } from "@kahveciderin/concave/node";
import { todos } from "./schema.js";

const db = drizzle(createClient({ url: process.env.DB_FILE_NAME ?? "file:./dev.db" }));

const app = createConcave({ cors: true }).resource(todos, {
  db,
  id: todos.id,
  auth: { public: true },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  onListen: ({ port }) => console.log(`Listening on ${port}`),
});
```

`startServer(app, options)` resolves once the server is listening and returns `{ port, address, close }`. If `port` is omitted, `PORT` from the environment is used (default 3000).

### Graceful Shutdown

By default `startServer` installs `SIGTERM`/`SIGINT` handlers that drain the instance
before exiting. On a shutdown signal it:

1. Flips the readiness flag so `/readyz` (and `HEAD /readyz`) immediately return `503` — load balancers and Kubernetes readiness probes stop routing new traffic to the instance.
2. Closes long-lived SSE subscription connections cleanly so clients reconnect to a healthy instance instead of seeing a dropped socket.
3. Waits a bounded drain window (`drainTimeoutMs`, default 10s) before closing the listener and exiting.

```typescript
await startServer(app, {
  port: 3000,
  drainTimeoutMs: 15000,    // how long to drain before forcing the socket closed
  // gracefulShutdown: false, // opt out and manage shutdown yourself via the returned close()
});
```

Set `gracefulShutdown: false` to manage shutdown yourself — the returned `close()` still
performs the same drain sequence when you call it. `/healthz` (liveness) keeps returning
`200` during drain; only `/readyz` flips to `503`.

## Cloudflare Workers

A `ConcaveApp` is a Hono app — export it as the Worker fetch handler:

```typescript
// src/worker.ts
import { drizzle } from "drizzle-orm/d1";
import { createConcave, type ConcaveApp } from "@kahveciderin/concave";
import { todos } from "./schema";

interface Env {
  DB: D1Database;
}

let app: ConcaveApp | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= createConcave({ cors: true }).resource(todos, {
      db: drizzle(env.DB),
      id: todos.id,
      auth: { public: true },
    });
    return app.fetch(request, env, ctx);
  },
};
```

If your app needs nothing from `env`, `export default app` works too — Hono apps are valid Worker handlers as-is.

### wrangler.toml

The `nodejs_compat` flag is required (Concave uses `node:crypto`):

```toml
name = "my-app"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

# SQLite via D1
[[d1_databases]]
binding = "DB"
database_name = "my-app-db"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

Create and migrate the D1 database:

```bash
wrangler d1 create my-app-db          # copy database_id into wrangler.toml
npx drizzle-kit generate
wrangler d1 migrations apply my-app-db --local
wrangler d1 migrations apply my-app-db --remote
wrangler deploy
```

### PostgreSQL on Workers

Use `postgres-js` with a connection string secret, and consider [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for connection pooling:

```typescript
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

interface Env {
  DATABASE_URL: string;
}

const buildApp = (env: Env) => {
  const client = postgres(env.DATABASE_URL, { max: 5, fetch_types: false });
  return createConcave({ cors: true }).resource(todos, { db: drizzle(client), id: todos.id });
};
```

```bash
wrangler secret put DATABASE_URL
```

```toml
# With Hyperdrive, bind it and use env.HYPERDRIVE.connectionString instead:
# [[hyperdrive]]
# binding = "HYPERDRIVE"
# id = "REPLACE_WITH_YOUR_HYPERDRIVE_ID"
```

### Shared State: Durable Object KV

The in-memory KV store is per-isolate. On Workers, Cloudflare may run many isolates of your app at once — without a shared KV, a mutation handled by one isolate never reaches SSE subscribers connected to another, and rate limits/sessions aren't shared. Concave ships a KV adapter backed by a **Durable Object** for exactly this:

```typescript
// src/worker.ts
import {
  createConcave,
  createDurableObjectKV,
  setGlobalKV,
  initializeEventSubscription,
  type ConcaveApp,
  type DurableObjectNamespaceLike,
} from "@kahveciderin/concave";

export { ConcaveKVDurableObject } from "@kahveciderin/concave";

interface Env {
  DB: D1Database;
  CONCAVE_KV: DurableObjectNamespaceLike;
}

let app: ConcaveApp | undefined;

const buildApp = (env: Env): ConcaveApp => {
  setGlobalKV(createDurableObjectKV(env.CONCAVE_KV));
  void initializeEventSubscription();
  return createConcave().resource(/* ... */);
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= buildApp(env);
    return app.fetch(request, env, ctx);
  },
};
```

```toml
# wrangler.toml
[durable_objects]
bindings = [{ name = "CONCAVE_KV", class_name = "ConcaveKVDurableObject" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ConcaveKVDurableObject"]
```

How it works:

- All KV operations (strings, hashes, sets, lists, sorted sets, TTLs, transactions) execute inside a single Durable Object, which is single-threaded — operations are strongly consistent and a `multi()` batch is atomic with respect to other requests.
- Collections are stored one entry per member in Durable Object storage, so they are not subject to the 128 KB single-value limit.
- Pub/sub uses **hibernatable WebSockets**: each isolate holds one WebSocket to the Durable Object for its subscriptions, and idle connections don't accrue Durable Object duration charges. Connections reconnect automatically with backoff.
- `createKV({ type: "durable-object", durableObject: { namespace: env.CONCAVE_KV } })` also works if you prefer the config-style factory; `createDurableObjectKV(namespace, { name?, prefix? })` is the direct form (the `name` selects which DO instance backs the store, default `"concave-kv"`).

Projects scaffolded with `npx concave create --template cloudflare` have all of this wired up out of the box.

#### Cross-process subscription fan-out

For multi-instance realtime to work, each instance must replay other instances' mutation
events into its local subscribers. If you initialize KV with `initializeKV(config)`, this
is wired automatically: for any distributed (non-memory) store, `initializeKV` calls
`initializeEventSubscription()` for you. The explicit `void initializeEventSubscription()`
call shown above is therefore only needed when you set the global KV directly with
`setGlobalKV(...)` instead of going through `initializeKV`.

```typescript
import { initializeKV } from "@kahveciderin/concave/kv";

// Distributed store + automatic cross-process subscription fan-out, one call:
await initializeKV({ type: "redis", redis: { url: process.env.REDIS_URL! } });
```

### Scaling Across Instances

Run as many instances as you like behind a load balancer. To keep realtime correct across
them, give every instance a shared, distributed KV store (Redis on Node, the Durable Object
KV on Workers) and initialize it via `initializeKV` so subscription fan-out is wired up.
With a shared store, a mutation handled by one instance reaches SSE subscribers connected to
any other instance, and rate limits, sessions, and the task queue are shared. The in-memory
KV is per-process and must not be used when state spans instances.

### Runtime Notes

- Concave never reads `process.env` directly — it uses runtime-safe helpers (`readEnv`, `isProduction`, `isDebugEnabled` from `@kahveciderin/concave`), so it works where `process` doesn't exist.
- Local filesystem storage (`initializeStorage({ type: "local" })`) is Node-only; use S3-compatible storage (e.g. R2) on Workers.
- The in-memory KV store is per-isolate on Workers; use the Durable Object KV (above) or Redis when state must be shared across instances.

### Cost: SSE Subscriptions on Workers

Cloudflare Workers bill **CPU time, not wall-clock time**. A long-lived idle SSE subscription costs essentially nothing while it waits: heartbeats and event pushes consume only microseconds of CPU each. Thousands of mostly-idle real-time connections are therefore cheap to keep open — duration of the connection does not multiply your bill.

## Database Matrix

Everything goes through Drizzle, so any Drizzle-supported driver works. Tested combinations:

| Database | Driver | Runtime | Notes |
|----------|--------|---------|-------|
| SQLite | `@libsql/client` (`drizzle-orm/libsql`) | Node | Local file or Turso |
| SQLite | `better-sqlite3` (`drizzle-orm/better-sqlite3`) | Node | Synchronous, fast local |
| SQLite | D1 (`drizzle-orm/d1`) | Workers | Native Cloudflare binding |
| PostgreSQL | `postgres` (`drizzle-orm/postgres-js`) | Node + Workers | Use Hyperdrive on Workers |
| PostgreSQL | `@neondatabase/serverless` (`drizzle-orm/neon-http`) | Node + Workers | HTTP driver, edge-friendly |
| PostgreSQL | `@electric-sql/pglite` (`drizzle-orm/pglite`) | Node | Embedded Postgres, great for tests |

```typescript
// better-sqlite3
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
const db = drizzle(new Database("data.db"));

// Neon
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
const db = drizzle(neon(process.env.DATABASE_URL!));

// PGlite
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
const db = drizzle(new PGlite());
```

## Health Checks

`createConcave` mounts `/healthz` (liveness) and `/readyz` (readiness) by default — wire these into your orchestrator (Kubernetes probes, load balancer checks). See [Admin UI](./admin-ui.md#health-endpoints) for configuration.

## Related

- [Getting Started](./getting-started.md) - Project setup
- [Migrating from Express](./migrating-from-express.md) - Upgrade guide
- [Admin UI](./admin-ui.md) - Health endpoints and monitoring
