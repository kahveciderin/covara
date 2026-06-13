---
id: live-queries
title: Live queries
sidebar_label: Live queries
description: The reactive LiveQuery store behind useLiveList — a hybrid fetch+subscribe cache with optimistic mutations, status tracking, and a framework-agnostic API.
---

# Live queries

A **LiveQuery** is the reactive store that powers [`useLiveList`](./react-hooks.md). It does the hybrid [fetch + subscribe](../realtime/subscriptions.md#hybrid-fetch--subscribe) dance, applies optimistic mutations, tracks connection status, and exposes a stable snapshot for `useSyncExternalStore`. Use it directly in non-React apps or for custom integrations.

```typescript
import { createLiveQuery, statusLabel } from "covara/client";

const todos = client.resource<Todo>("/api/todos");

const liveQuery = createLiveQuery(todos, {
  filter: 'userId=="123"',
  orderBy: "position",
  limit: 100,
}, {
  onAuthError: () => redirectToLogin(),
  getPendingCount: () => client.getPendingCount(),
  onIdRemapped: (optimisticId, serverId) => console.log(`${optimisticId} -> ${serverId}`),
});

const state = liveQuery.getSnapshot(); // stable reference
// { items, status, error, pendingCount, lastSeq }

const unsubscribe = liveQuery.subscribe(() => render(liveQuery.getSnapshot()));

liveQuery.mutate.create({ title: "New" });
liveQuery.mutate.update("123", { completed: true });
liveQuery.mutate.delete("123");

await liveQuery.refresh();
statusLabel(state.status, state.pendingCount); // "Live", "Loading…", "Offline (3 pending)"
liveQuery.destroy();
```

## State

```typescript
interface LiveQueryState<T> {
  items: T[];
  status: "loading" | "live" | "reconnecting" | "offline" | "error";
  error: Error | null;
  pendingCount: number;
  lastSeq: number;
}
```

## How it stays live

1. Fetch the initial page via `GET`.
2. Subscribe with `skipExisting=true`, passing the known IDs.
3. Apply `added`/`changed`/`removed` events to the in-memory list, honoring the [subscription mode](../realtime/subscriptions.md#subscription-modes-paginated-views).
4. Apply optimistic mutations immediately; reconcile against server responses (and remap temporary IDs).
5. On `invalidate` (sequence gap, auth change, backpressure), refetch.

The store is cached per `(path, options)` by the client, so multiple components reading the same query share one subscription. `client.invalidate(...)` and `client.prefetch(...)` operate on these caches — see [Overview](./overview.md#client-methods).

## Low-level subscriptions

For full control without the store, subscribe directly — see [Subscriptions → low-level API](../realtime/subscriptions.md#low-level-client-api).

## Related

- [React hooks](./react-hooks.md) · [Subscriptions](../realtime/subscriptions.md) · [Offline](./offline.md)
