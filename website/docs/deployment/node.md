---
id: node
title: Deploy on Node
sidebar_label: Node
description: Run a Covara app standalone with startServer from covara/node, including graceful shutdown that drains SSE connections for zero-downtime deploys.
---

# Deploy on Node

A `CovaraApp` runs standalone on Node via `startServer` from `covara/node` (which wraps `@hono/node-server`).

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createCovara } from "covara";
import { startServer } from "covara/node";
import { todos } from "./schema.js";

const db = drizzle(createClient({ url: process.env.DB_FILE_NAME ?? "file:./dev.db" }));

const app = createCovara({ cors: true }).resource(todos, {
  db, id: todos.id, auth: { public: true },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  onListen: ({ port }) => console.log(`Listening on ${port}`),
});
```

`startServer(app, options)` resolves once the server is listening and returns `{ port, address, close }`. If `port` is omitted, `PORT` from the environment is used (default 3000).

## Graceful shutdown

By default `startServer` installs `SIGTERM`/`SIGINT` handlers that drain the instance before exiting. On a shutdown signal it:

1. Flips readiness so [`/readyz`](../platform/health.md) returns `503` — load balancers and Kubernetes readiness probes stop routing new traffic here.
2. Closes long-lived [SSE subscriptions](../realtime/subscriptions.md) cleanly so clients reconnect to a healthy instance instead of seeing a dropped socket.
3. Waits a bounded drain window (`drainTimeoutMs`, default 10s) before closing the listener and exiting.

```typescript
await startServer(app, {
  port: 3000,
  drainTimeoutMs: 15000,    // drain window before forcing the socket closed
  // gracefulShutdown: false, // opt out and manage shutdown yourself via close()
});
```

Set `gracefulShutdown: false` to manage shutdown yourself — the returned `close()` still performs the same drain sequence. `/healthz` (liveness) keeps returning `200` during drain; only `/readyz` flips to `503`.

## Docker

`npx covara create` writes a `Dockerfile` and `docker-compose.yml` (app + Redis, plus Postgres when `--db postgres`) and a `.dockerignore`. See the [CLI](../tooling/cli.md).

## Scaling

Run multiple instances behind a load balancer; give every instance a shared [Redis KV](../platform/kv.md) (via `initializeKV`) so [subscriptions](../realtime/subscriptions.md), sessions, rate limits, and the [task queue](../platform/tasks.md) are shared. See [Scaling across instances](./workers.md#scaling-across-instances).

## Runtime notes

- Covara never reads `process.env` directly — it uses runtime-safe helpers (`readEnv`, `isProduction`, `isDebugEnabled`). See [Environment variables](./environment-variables.md).
- [Local filesystem storage](../platform/storage.md) is available on Node (use R2/S3 on Workers).

## Related

- [Cloudflare Workers](./workers.md) · [Database matrix](./databases.md) · [Health checks](../platform/health.md)
- [Environment variables](./environment-variables.md) · [CLI](../tooling/cli.md)
