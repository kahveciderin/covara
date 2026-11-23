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
import { env } from "./env.js"; // your createEnv schema — see Environment variables

const db = drizzle(createClient({ url: env.DB_FILE_NAME }));

const app = createCovara({ cors: true }).resource(todos, {
  db, id: todos.id, auth: { public: true },
});

const server = await startServer(app, {
  port: env.PORT,
  hostname: "0.0.0.0",
  onListen: ({ port }) => console.log(`Listening on ${port}`),
});
```

`startServer(app, options)` resolves once the server is listening and returns `{ port, address, close }`. If `port` is omitted, `PORT` from the environment is used (default 3000).

## Graceful shutdown

By default `startServer` installs `SIGTERM`/`SIGINT` handlers that drain the instance before exiting. On a shutdown signal it:

1. Flips readiness so [`/readyz`](../platform/health.md) returns `503` — load balancers and Kubernetes readiness probes stop routing new traffic here.
2. Closes long-lived [SSE subscriptions](../realtime/subscriptions.md) cleanly so clients reconnect to a healthy instance instead of seeing a dropped socket.
3. Waits up to 5s for background writes (session activity stamps) to settle, and starts no new ones. If you manage shutdown yourself, `await beginShutdown()` before closing your database.
4. Waits a bounded drain window (`drainTimeoutMs`, default 10s) before closing the listener and exiting.

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

## Behind a proxy: the client IP

Every per-IP limit (rate limits, the login throttle, the abuse budget, the admin and OIDC limits, the SSE subscription caps) keys on `getClientIP(c)`. By default on Node that is the **socket address**: `X-Forwarded-For`, `X-Real-IP` and `CF-Connecting-IP` are ignored, because any client can send them. Behind nginx, Caddy, a load balancer or Cloudflare, every request then comes from the proxy, so tell Covara which peers to trust:

```typescript
createCovara({
  trustProxy: ["loopback"],            // nginx/Caddy on the same host
  // trustProxy: ["10.0.0.0/8"],       // a load balancer in your private network
  // trustProxy: 1,                    // exactly one proxy in front, whatever its address
  // trustProxy: "cloudflare",         // CF-Connecting-IP; only if the origin accepts nothing but Cloudflare
});
```

| `trustProxy` | Client IP |
| --- | --- |
| `false` (default) | The socket address |
| list of IPs, CIDR ranges, `loopback`, `linklocal`, `uniquelocal` | If the socket peer is in the list, `X-Forwarded-For` is read from the right, skipping entries in the list; the first one outside it is the client (all trusted: the left-most). Without `X-Forwarded-For`, `X-Real-IP`. An untrusted peer's headers are ignored |
| a number `n` | The `n`-th address counting from the socket peer leftwards through `X-Forwarded-For` (`1`: the right-most entry) |
| `"cloudflare"` | `CF-Connecting-IP` from any peer, else the socket address. **Only safe when the origin is reachable solely through Cloudflare** (Cloudflare Tunnel, a firewall limited to Cloudflare's IP ranges, or Authenticated Origin Pulls): anyone who reaches it directly can set the header and choose their IP. Otherwise list Cloudflare's IP ranges instead |

Reading from the right matters: proxies append to an incoming `X-Forwarded-For`, so its left-most entries are whatever the client sent. `clientIp: (c) => string | undefined` overrides all of this in one place (return nothing to fall back). Outside `createCovara`, call `configureClientIp({ trustProxy, clientIp })`. When forwarding headers arrive and are ignored, Covara logs one `warn` saying so.

## Scaling

Run multiple instances behind a load balancer; give every instance a shared [Redis KV](../platform/kv.md) (via `initializeKV`) so [subscriptions](../realtime/subscriptions.md), sessions, rate limits, and the [task queue](../platform/tasks.md) are shared. See [Scaling across instances](./workers.md#scaling-across-instances).

## Runtime notes

- Covara never reads `process.env` directly — it uses runtime-safe helpers (`readEnv`, `isProduction`, `isDebugEnabled`). See [Environment variables](./environment-variables.md).
- [Local filesystem storage](../platform/storage.md) is available on Node (use R2/S3 on Workers).

## Related

- [Cloudflare Workers](./workers.md) · [Database matrix](./databases.md) · [Health checks](../platform/health.md)
- [Environment variables](./environment-variables.md) · [CLI](../tooling/cli.md)
