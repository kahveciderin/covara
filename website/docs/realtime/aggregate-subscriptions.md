---
id: aggregate-subscriptions
title: Aggregate subscriptions
sidebar_label: Aggregate subscriptions
description: Live aggregations over SSE — recompute-on-change with scope-aware skipping, debounced re-emit, order-independent dedup, and cross-process fan-out.
---

# Aggregate subscriptions

`GET /aggregate/subscribe` streams an [aggregation](../core/aggregations.md) result and **recomputes + re-emits it whenever the resource is mutated**. Because the result is recomputed from the database each time, it stays exact for any `groupBy`/`having` combination — there is no incremental-aggregation drift.

This is recompute-on-change, not row tracking — a fundamentally different model from [row subscriptions](./subscriptions.md).

## React

```tsx
import { useLiveAggregate } from "covara/client/react";

function TodoStats() {
  const { groups, isLive } = useLiveAggregate("/api/todos", {
    groupBy: ["completed"],
    count: true,
  });
  const completed = groups.find((g) => g.key?.completed)?.count ?? 0;
  return <div>{completed} completed {isLive ? "🟢" : "…"}</div>;
}
```

## Imperative client

```typescript
const todos = client.resource<Todo>("/api/todos");

const sub = todos.subscribeAggregate(
  { groupBy: ["status"], count: true, sum: ["amount"] },
  {
    onData: (result) => console.log(result.groups),
    onConnectionChange: (connected) => console.log("live:", connected),
  }
);

sub.unsubscribe();
```

## Semantics

- **On connect** the server emits `connected`, then one `aggregate` event with the current snapshot (even when the resource is empty).
- **Scope-aware skipping.** Each subscription carries its compiled read [scope](../auth/scopes.md) + `filter` and is handed the changed rows — the new row for inserts, new **and** previous state for updates, and the deleted rows' prior content for deletes. It **skips the recompute when no changed row is in its scope**, so a per-user aggregate like `userId==<me>` does **not** recompute on other users' inserts, updates, or deletes. This keeps cost bounded with many concurrent per-user subscriptions. Unscoped/global aggregates always recompute.
- **Safe fallbacks.** Raw-SQL/external [invalidations](./mutation-tracking.md) and cross-process notifications fall back to an unconditional recompute (row data isn't shipped over pub/sub). Skipping is applied only when provably safe; the result dedup below is the correctness backstop, so over-recomputing never yields a wrong result.
- **Debounce + dedup.** Bursts of mutations coalesce into a single recompute (`sse.aggregateDebounceMs`, default **150 ms**). An event is suppressed when the recomputed result matches the previous one under an **order-independent** comparison (group order is normalized, since `GROUP BY` has no stable `ORDER BY`).
- **Cross-process.** In multi-process deployments, mutations fan out to watchers via the [KV](../platform/kv.md) pub/sub channel (the same KV that powers row subscriptions).
- **No resume.** The read scope and `filter` are resolved once at connect and reused for the connection's life. Aggregate subscriptions don't support `resumeFrom`/catchup — a reconnect simply re-emits the current snapshot.

## Server tuning

```typescript
useResource(todos, {
  db,
  id: todos.id,
  sse: { aggregateDebounceMs: 150 },
});
```

## How it works internally

`registerAggregateWatcher(resource, cb)` registers a local watcher; the mutation push paths call `notifyAggregateWatchers(resource, changedRows?)` (local + cross-process via the `covara:aggregate` KV channel). Each watcher decides whether to recompute based on its scope and the changed rows.

## Related

- [Aggregations](../core/aggregations.md) · [Subscriptions](./subscriptions.md) · [Mutation tracking](./mutation-tracking.md)
- [React hooks](../client/react-hooks.md) · [KV store](../platform/kv.md)
