---
id: react-hooks
title: React hooks
sidebar_label: React hooks
description: useLiveList, useInfiniteList, useLiveAggregate, useMutation, useSearch, useAuth, file and billing hooks, plus invalidation and prefetch — the full React surface.
---

# React hooks

Import hooks from `covara/client/react`. They build on the [LiveQuery store](./live-queries.md) and the typed [repository](./queries.md).

## `useLiveList`

The primary hook for real-time lists with optimistic mutations.

```tsx
import { useLiveList } from "covara/client/react";

function TodoList() {
  const {
    items, status, statusLabel, error, pendingCount,
    isLoading, isLive, isOffline, isReconnecting,
    hasMore, totalCount, isLoadingMore,
    mutate, refresh, loadMore,
  } = useLiveList<Todo>("/api/todos", {
    filter: 'userId=="123"',
    orderBy: "position",
    limit: 100,
    include: "category,tags",
    subscriptionMode: "strict",
    enabled: true,
    select: ["id", "title", "completed"],
  });

  return (
    <ul>
      {items.map((t) => (
        <li key={t.id}>
          <input type="checkbox" checked={t.completed}
            onChange={() => mutate.update(t.id, { completed: !t.completed })} />
          {t.title}
          <button onClick={() => mutate.delete(t.id)}>×</button>
        </li>
      ))}
    </ul>
  );
}
```

`status`: `"loading" | "live" | "reconnecting" | "offline" | "error"`. `mutate.create/update/delete` apply [optimistically](./offline.md). Pass a [typed `ResourceClient`](./typegen.md) instead of a path to infer `T`:

```tsx
const { items } = useLiveList(client.resources.todos, { orderBy: "position" });
```

### Pagination

With a `limit`, the hook exposes `hasMore`, `totalCount`, `isLoadingMore`, and `loadMore()`:

```tsx
const { items, hasMore, loadMore, isLoadingMore } = useLiveList<Todo>("/api/todos", { limit: 20 });
{hasMore && <button onClick={loadMore} disabled={isLoadingMore}>Load more</button>}
```

### Subscription modes

Control how other clients' changes affect a paginated view — `strict` (default with `limit`), `sorted`, `append`, `prepend`, or `live` (default without `limit`). See [Subscriptions → modes](../realtime/subscriptions.md#subscription-modes-paginated-views).

### Type-safe projections

```tsx
const { items } = useLiveList<User, "id" | "name" | "avatar">("/api/users", { select: ["id", "name", "avatar"] });
// items: { id; name; avatar }[]
```

### Relations & optimistic updates

With `include`, changing a foreign key clears the stale relation immediately and refills it from the server response. For instant UX, look it up from local cache (`todo.category ?? categories.find(c => c.id === todo.categoryId)`). See [Subscriptions → relations](../realtime/subscriptions.md#relations-in-events).

## `useInfiniteList`

Cursor-paginated live list; pages accumulate into `items` and stay realtime-aware.

```tsx
const { items, fetchNextPage, hasNextPage, isFetchingNextPage } =
  useInfiniteList<Todo>("/api/todos", { limit: 20, orderBy: "createdAt:desc" });
```

## `useLiveAggregate`

Live [aggregation](./live-queries.md) that recomputes on every change. See [Aggregate subscriptions](../realtime/aggregate-subscriptions.md).

```tsx
const { groups, isLive } = useLiveAggregate("/api/todos", { groupBy: ["completed"], count: true });
```

## `useMutation`

Standalone mutation hook usable outside a list; integrates with optimistic updates, the offline queue, and invalidation.

```tsx
const { mutate, mutateAsync, status, error, reset } = useMutation<Todo>("/api/todos", {
  invalidates: ["/api/todos"],
  onSuccess: (todo) => toast(`Created ${todo.id}`),
});

mutate({ kind: "create", data: { title: "New" } });
mutate({ kind: "update", id: "1", data: { completed: true } });
mutate({ kind: "delete", id: "2" });

// custom function form
const remove = useMutation(async ({ id }: { id: string }, ctx) => {
  await ctx.resource.delete(id);
  ctx.invalidate("/api/todos");
}, { resource: "/api/todos" });
```

## `useSearch`

Debounced [full-text search](../core/search.md):

```tsx
const { items, isSearching, search, clear } = useSearch(client.resources.todos, { enabled: true });
search("important");
```

## Invalidation & prefetch

```tsx
import { useInvalidate } from "covara/client/react";

const invalidate = useInvalidate();
await save();
invalidate("/api/todos"); // same semantics as client.invalidate
```

`client.prefetch(path, options)` warms the cache so a later `useLiveList` skips the loading flash. See [Overview](./overview.md#client-methods).

## Other hooks

| Hook | Purpose | Page |
|------|---------|------|
| `useAuth` | Auth state (cookie/JWT/bearer/apiKey/auto) | [Client auth](./auth.md) |
| `useJWTAuth` | JWT login/signup/refresh | [JWT](../auth/jwt.md) |
| `usePublicEnv` | Public env vars | [Environment variables](../deployment/environment-variables.md) |
| `useFileUpload` / `useFile` / `useFiles` | File uploads | [File uploads](./files.md) |
| `useCredits` / `useSubscription` / `useCheckout` | Billing | [Billing hooks](./billing.md) |

## Related

- [Live queries](./live-queries.md) · [Queries & repository](./queries.md) · [Offline](./offline.md)
- [Subscriptions](../realtime/subscriptions.md) · [Type generation](./typegen.md)
