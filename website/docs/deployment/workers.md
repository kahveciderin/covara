---
id: workers
title: Deploy on Cloudflare Workers
sidebar_label: Cloudflare Workers
description: Run a Covara app at the edge — D1/Postgres, nodejs_compat, the Durable Object KV for shared state, cross-process subscription fan-out, and SSE cost notes.
---

# Deploy on Cloudflare Workers

A `CovaraApp` is a Hono app, so it works directly as a Worker fetch handler.

```typescript
// src/worker.ts
import { drizzle } from "drizzle-orm/d1";
import { createCovara, type CovaraApp } from "covara";
import { todos } from "./schema";

interface Env { DB: D1Database }

let app: CovaraApp | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= createCovara({ cors: true }).resource(todos, {
      db: drizzle(env.DB), id: todos.id, auth: { public: true },
    });
    return app.fetch(request, env, ctx);
  },
};
```

If your app needs nothing from `env`, `export default app` works too.

### D1 and transactions

Cloudflare D1 has **no interactive transactions** (drizzle's `db.transaction()` would issue `BEGIN`/`COMMIT`, which D1 rejects). Covara detects D1 automatically and adapts: single-statement mutations (create/update/replace/delete) auto-commit atomically, and batch upsert uses D1's atomic `db.batch()`. Two limitations are inherent to D1: `nestedWrites` creates run sequentially (not atomic), and a throwing `onAfter*` hook can't roll back an already-committed write. If you wire a custom driver the detection can't classify, set `transactions: true | false` in the resource config. See the [mutation-tracking contract](../contracts/track-mutations.md#engines-without-interactive-transactions-cloudflare-d1).

## wrangler.toml

`nodejs_compat` is required (Covara uses `node:crypto`):

```toml
name = "my-app"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "my-app-db"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

```bash
wrangler d1 create my-app-db          # copy database_id into wrangler.toml
npx drizzle-kit generate
wrangler d1 migrations apply my-app-db --local
wrangler d1 migrations apply my-app-db --remote
wrangler deploy
```

## PostgreSQL on Workers

Use `postgres-js` with a connection-string secret, and consider [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for pooling:

```typescript
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const buildApp = (env: { DATABASE_URL: string }) => {
  const client = postgres(env.DATABASE_URL, { max: 5, fetch_types: false });
  return createCovara({ cors: true }).resource(todos, { db: drizzle(client), id: todos.id });
};
```

```bash
wrangler secret put DATABASE_URL
```

See the full [database matrix](./databases.md).

## Shared state: Durable Object KV

The in-memory KV is per-isolate, and Cloudflare runs many isolates — without a shared KV, a mutation handled by one isolate never reaches [SSE subscribers](../realtime/subscriptions.md) on another, and rate limits/sessions aren't shared. Use the [Durable Object KV](./durable-object-kv.md):

```typescript
import { createCovara, createDurableObjectKV, setGlobalKV, initializeEventSubscription, type CovaraApp } from "covara";
export { CovaraKVDurableObject } from "covara";

interface Env { DB: D1Database; COVARA_KV: DurableObjectNamespace }

let app: CovaraApp | undefined;
const buildApp = (env: Env): CovaraApp => {
  setGlobalKV(createDurableObjectKV(env.COVARA_KV));
  void initializeEventSubscription();
  return createCovara().resource(/* ... */);
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= buildApp(env);
    return app.fetch(request, env, ctx);
  },
};
```

```toml
[durable_objects]
bindings = [{ name = "COVARA_KV", class_name = "CovaraKVDurableObject" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CovaraKVDurableObject"]
```

Projects from `npx covara create --template cloudflare` wire all of this up. See [Durable Object KV](./durable-object-kv.md) for how it works.

## Scaling across instances

Run as many instances as you like behind a load balancer. For realtime to stay correct, give every instance a shared distributed [KV](../platform/kv.md) (Redis on Node, the Durable Object KV on Workers) and initialize it via `initializeKV` so subscription fan-out is wired up:

```typescript
import { initializeKV } from "covara/kv";
await initializeKV({ type: "redis", redis: { url: env.REDIS_URL } });
```

`initializeKV` calls `initializeEventSubscription()` for any distributed store, so a mutation on one instance reaches subscribers on another, and rate limits, sessions, and the task queue are shared. The explicit `void initializeEventSubscription()` is only needed when you use `setGlobalKV(...)` directly. The in-memory KV is per-process and must not be used when state spans instances.

## Cost: SSE subscriptions on Workers

Cloudflare bills **CPU time, not wall-clock time**. A long-lived idle SSE subscription costs essentially nothing while it waits — heartbeats and event pushes consume only microseconds of CPU each. Thousands of mostly-idle realtime connections are cheap to keep open.

## Background tasks on the edge

There's no long-lived poller on Workers — use the [Cloudflare Queues adapter](../platform/tasks.md#cloudflare-queues), and drain the [search outbox](../core/search.md#transactional-outbox-at-least-once-indexing) from a `scheduled` handler.

## Runtime notes

- Covara never reads `process.env` directly (`readEnv`/`isProduction`/`isDebugEnabled`), so it works where `process` doesn't exist.
- [Local filesystem storage](../platform/storage.md) is Node-only; use R2 or S3-compatible storage on Workers.

## Related

- [Durable Object KV](./durable-object-kv.md) · [Database matrix](./databases.md) · [Tasks](../platform/tasks.md)
- [Environment variables](./environment-variables.md) · [CLI](../tooling/cli.md)
