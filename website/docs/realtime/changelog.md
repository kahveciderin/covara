---
id: changelog
title: Changelog
sidebar_label: Changelog
description: The central, monotonically-sequenced log of all mutations that powers reliable, resumable subscriptions and catch-up on reconnect.
---

# Changelog

The changelog is the backbone of Covara's [subscriptions](./subscriptions.md). Every mutation — through a generated endpoint, an [RPC procedure](../core/procedures.md), or a [tracked](./mutation-tracking.md) custom route — appends an entry with a **monotonic sequence number**. Subscriptions read the changelog to deliver ordered, resumable deltas.

## Why it exists

- **Reliable delivery.** Clients track their last received `seq`. On reconnect they resume from it, so no events are silently lost.
- **Gap detection.** If the rolling window has advanced past a client's `seq` (it was offline too long), the server sends an `invalidate` event and the client refetches from a consistent snapshot.
- **Decoupling.** Producers (any mutation path) and consumers (any subscription) communicate only through sequence numbers, which is what makes [cross-instance fan-out](../deployment/workers.md#scaling-across-instances) work over a shared [KV](../platform/kv.md).

## Entry shape

```typescript
interface ChangelogEntry {
  resource: string;          // e.g. "todos"
  type: "create" | "update" | "delete";
  objectId: string;          // affected id, or "*" for raw-SQL/bulk mutations
  object?: unknown;          // new/updated row (absent for invalidate-only entries)
  previousObject?: unknown;  // prior state for updates/deletes
  timestamp: number;
  seq: number;               // monotonic sequence number
}
```

Entries with `objectId: "*"` (raw SQL, batch, external mutations) carry no row detail, so subscribers receive an `invalidate` rather than a precise `added`/`changed`/`removed`.

## Storage & rolling window

The changelog keeps a configurable maximum number of recent entries (a rolling window) in the [KV store](../platform/kv.md). Older entries age out; a client resuming from a sequence below the window's floor gets `invalidate` instead of a precise replay.

Subscription storage is **sharded per resource** (`covara:subs:byres:<resource>` plus a `covara:subs:resources` index, with subscription IDs embedding their resource as `<uuid>:<resource>`), so a mutation only loads the mutated resource's subscriptions rather than scanning all of them.

## Programmatic access

```typescript
import { changelog } from "covara";
```

The `changelog` export exposes the append/read primitives the framework uses internally; most applications never touch it directly and instead rely on [`trackMutations`](./mutation-tracking.md) and the generated endpoints to populate it.

## Related

- [Subscriptions](./subscriptions.md) · [Mutation tracking](./mutation-tracking.md) · [KV store](../platform/kv.md)
- [Subscriptions contract](../contracts/subscriptions.md) — ordering, resume, and delivery guarantees
