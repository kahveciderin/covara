---
id: kv
title: KV store
sidebar_label: KV store
description: The Redis-compatible key-value abstraction behind subscriptions, sessions, tasks, rate limits, and the changelog — memory, Redis, and Durable Object backends, with cross-process pub/sub.
---

# KV store

A Redis-compatible key-value abstraction underpins much of Covara: cross-isolate [subscriptions](../realtime/subscriptions.md), [sessions](../auth/sessions.md), the [task queue](./tasks.md), [rate limits](../tooling/middleware.md), the [changelog](../realtime/changelog.md), [billing](./billing.md) idempotency, and the [search outbox](../core/search.md). Initialize it once and the framework wires everything to it.

## Backends

| Backend | `type` | Use |
|---------|--------|-----|
| Memory | `memory` | Development, single process. Per-isolate — not shared. |
| Redis | `redis` | Production on Node / multi-instance. |
| Durable Object | `durable-object` | Cloudflare Workers — shared state without Redis. |

## Initialize

The recommended entry point is `initializeKV`, which also wires **cross-process subscription fan-out** for distributed stores:

```typescript
import { initializeKV } from "covara/kv";

// Development
await initializeKV({ type: "memory", prefix: "my-app" });

// Production (Node)
await initializeKV({ type: "redis", redis: { url: env.REDIS_URL } });
```

For any distributed (non-memory) store, `initializeKV` calls `initializeEventSubscription()` for you, so a mutation on one instance reaches subscribers on another. If you instead set the global KV directly with `setGlobalKV(...)`, call `initializeEventSubscription()` yourself.

```typescript
import { getGlobalKV, setGlobalKV } from "covara";

const kv = getGlobalKV(); // throws if not initialized
```

## Durable Object KV (Workers)

The in-memory KV is per-isolate, and Cloudflare runs many isolates — so a mutation handled by one isolate wouldn't reach subscribers on another without a shared store. The Durable Object KV solves this:

```typescript
import { createDurableObjectKV, setGlobalKV, initializeEventSubscription } from "covara";
export { CovaraKVDurableObject } from "covara";

setGlobalKV(createDurableObjectKV(env.COVARA_KV));
void initializeEventSubscription();
```

```toml
[durable_objects]
bindings = [{ name = "COVARA_KV", class_name = "CovaraKVDurableObject" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CovaraKVDurableObject"]
```

Key properties:

- All operations (strings, hashes, sets, lists, sorted sets, TTLs, transactions) run inside a single, single-threaded Durable Object — **strongly consistent**, and a `multi()` batch is atomic.
- Collections store **one entry per member**, avoiding the 128 KB single-value cap.
- Pub/sub uses **hibernatable WebSockets** — one WebSocket per isolate, idle connections don't accrue duration charges, automatic reconnect with backoff.
- Zero Cloudflare imports (structural types), so it's Node-testable.

`createDurableObjectKV(namespace, { name?, prefix? })` is the direct form (`name` selects the DO instance, default `"covara-kv"`); `createKV({ type: "durable-object", durableObject: { namespace: env.COVARA_KV } })` is the config-style equivalent. Full setup in [Durable Object KV deployment](../deployment/durable-object-kv.md).

## What uses the KV

| Feature | What it stores |
|---------|----------------|
| [Subscriptions](../realtime/subscriptions.md) / [changelog](../realtime/changelog.md) | Sharded subscriptions, changelog window, cross-process events |
| [Aggregate subscriptions](../realtime/aggregate-subscriptions.md) | The `covara:aggregate` pub/sub channel |
| [Sessions](../auth/sessions.md) | Session records (Redis store) |
| [Tasks](./tasks.md) | Queue, locks, idempotency, results, DLQ |
| [Rate limiting](../tooling/middleware.md) / [login throttle](../auth/account-security.md) | Counters |
| [OIDC](../auth/oidc-provider.md) | Clients, codes, refresh tokens, consents (when KV present) |
| [Billing](./billing.md) | Webhook dedupe, credits ledger |
| [Search outbox](../core/search.md) | Index queue, in-flight ops, dead set |

## Related

- [Subscriptions](../realtime/subscriptions.md) · [Tasks](./tasks.md) · [Durable Object KV](../deployment/durable-object-kv.md)
- [Scaling across instances](../deployment/workers.md#scaling-across-instances)
