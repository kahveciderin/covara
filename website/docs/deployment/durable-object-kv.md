---
id: durable-object-kv
title: Durable Object KV
sidebar_label: Durable Object KV
description: Shared, strongly-consistent state on Cloudflare Workers without Redis — cross-isolate subscriptions, sessions, rate limits, and tasks backed by a single Durable Object with hibernatable-WebSocket pub/sub.
---

# Durable Object KV

On Cloudflare Workers the in-memory [KV](../platform/kv.md) is per-isolate, and Cloudflare may run many isolates of your app at once. Without a shared KV:

- a mutation handled by one isolate never reaches [SSE subscribers](../realtime/subscriptions.md) connected to another,
- [rate limits](../tooling/middleware.md) and [sessions](../auth/sessions.md) aren't shared,
- the [task queue](../platform/tasks.md) can't coordinate.

The **Durable Object KV** gives you shared, strongly-consistent state on Workers without standing up Redis.

## Setup

```typescript
// src/worker.ts
import {
  createCovara, createDurableObjectKV, setGlobalKV,
  type CovaraApp, type DurableObjectNamespaceLike,
} from "covara";

export { CovaraKVDurableObject } from "covara";

interface Env { DB: D1Database; COVARA_KV: DurableObjectNamespaceLike }

let app: CovaraApp | undefined;
const buildApp = (env: Env): CovaraApp => {
  // Memoizing the app is safe: the store derives a fresh DO stub per operation
  // (Workers requires request-scoped I/O), and cross-isolate subscription
  // fan-out is set up lazily per live SSE stream.
  setGlobalKV(createDurableObjectKV(env.COVARA_KV));
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
# wrangler.toml
[durable_objects]
bindings = [{ name = "COVARA_KV", class_name = "CovaraKVDurableObject" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CovaraKVDurableObject"]
```

You re-export `CovaraKVDurableObject` from your worker so wrangler can bind it. Projects from `npx covara create --template cloudflare` have all of this wired up.

## How it works

- **Strong consistency.** All KV operations (strings, hashes, sets, lists, sorted sets, TTLs, transactions) run inside a single, single-threaded Durable Object — operations are strongly consistent, and a `multi()` batch is atomic with respect to other requests.
- **No 128 KB cap.** Collections are stored **one entry per member** in Durable Object storage, so they aren't limited by the 128 KB single-value cap.
- **Request-scoped stubs.** Every operation derives a fresh Durable Object stub from the (stable) namespace binding rather than caching one. Workers forbids reusing a request-scoped I/O object across requests, so a cached stub would make every request after the first fail with `Cannot perform I/O on behalf of a different request` — deriving per operation avoids that while keeping the KV store itself memoizable.
- **Per-stream hibernatable WebSocket pub/sub.** Each live SSE stream opens its **own** dedicated subscribe WebSocket to the Durable Object, bound to that request's context (not module state) — so closing one stream never affects another's fan-out. The socket opens only while a stream is live and closes when it ends; idle connections don't accrue Durable Object duration charges, and each reconnects automatically with backoff. A process doing only KV ops never opens one.
- **Zero Cloudflare imports.** It uses structural types, so the implementation is Node-testable.

## Factory forms

```typescript
// Direct (name selects which DO instance backs the store; default "covara-kv")
createDurableObjectKV(env.COVARA_KV, { name: "covara-kv", prefix: "app" });

// Config-style
createKV({ type: "durable-object", durableObject: { namespace: env.COVARA_KV } });
```

## Cross-process fan-out

`initializeEventSubscription()` makes each isolate replay other isolates' mutation events into its local subscribers. If you initialize via `initializeKV(config)` instead of `setGlobalKV(...)`, this is called automatically for any distributed store. See [Scaling across instances](./workers.md#scaling-across-instances).

## Related

- [KV store](../platform/kv.md) · [Cloudflare Workers](./workers.md) · [Subscriptions](../realtime/subscriptions.md)
- [Tasks](../platform/tasks.md)
