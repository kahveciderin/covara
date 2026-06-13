---
id: offline
title: Offline support
sidebar_label: Offline support
description: Optimistic updates, a persisted mutation queue, automatic sync on reconnect, ID remapping, and conflict handling — with LocalStorage or IndexedDB backends.
---

# Offline support

The client supports offline-first apps: mutations apply optimistically, queue locally while offline, and sync automatically when the connection returns. [`useLiveList`](./live-queries.md) wires all of this up for you.

## Enable it

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true, // LocalStorage with sensible defaults
});
```

```tsx
import { useLiveList } from "covara/client/react";

function TodoApp() {
  const { items, statusLabel, mutate, pendingCount } = useLiveList<Todo>("/api/todos", { orderBy: "position" });
  return (
    <>
      <ul>{items.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
      <button onClick={() => mutate.create({ title: "New" })}>Add</button>
      <footer>{statusLabel}{pendingCount > 0 && ` • ${pendingCount} pending`}</footer>
    </>
  );
}
```

Mutations update the UI instantly, queue when offline, sync on reconnect, and remap temporary IDs to server IDs — automatically.

## Advanced configuration

```typescript
import { createClient, LocalStorageOfflineStorage } from "covara/client";

const client = createClient({
  baseUrl: "/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("my-app-offline"),
    maxRetries: 5,
    retryDelay: 2000,
    onIdRemapped: (optimisticId, serverId) => console.log(`${optimisticId} -> ${serverId}`),
  },
  onError: (error) => console.error("Sync error:", error),
  onSyncComplete: () => console.log("All changes synced"),
});
```

### Storage backends

| Backend | Notes |
|---------|-------|
| `LocalStorageOfflineStorage("prefix")` | Default with `offline: true`. |
| `IndexedDB` | Higher capacity; provide via the `OfflineStorage` interface or the built-in IndexedDB storage. |
| `InMemoryOfflineStorage` | Tests. |

Implement your own by satisfying `OfflineStorage` (`getMutations`/`addMutation`/`updateMutation`/`removeMutation`/`clear`).

## Optimistic mutations (imperative)

```typescript
const users = client.resource<User>("/users");

const created = await users.create({ name: "Alice" }, { optimistic: true }); // temp id like "optimistic_..."
await users.update("123", { name: "Alice Smith" }, { optimistic: true });
await users.delete("123", { optimistic: true });
```

## Mutation queue

```typescript
await client.offline?.getPendingMutations();   // [{ id, type, resource, data, status, retryCount }]
await client.offline?.syncPendingMutations();  // trigger sync
await client.offline?.clearMutations();         // clear (use with care)
client.offline?.getIsOnline();                  // current status
```

The client listens to browser `online`/`offline` events and syncs when reconnecting.

### Mutation states

| State | Meaning |
|-------|---------|
| `pending` | Waiting to sync |
| `processing` | Syncing now |
| `failed` | Sync failed; will retry |

## Conflict resolution

When syncing, use the `OfflineManager` to resolve conflicts (server-wins / client-wins / merge):

```typescript
import { createOfflineManager, InMemoryOfflineStorage } from "covara/client";

const offlineManager = createOfflineManager({
  config: { enabled: true, maxRetries: 5, storage: new InMemoryOfflineStorage() },
  onMutationSync: async (mutation) => {
    if (mutation.type === "update") {
      const current = await resource.get(mutation.objectId!);
      if (current.updatedAt > mutation.timestamp) {
        return; // server wins — or merge / client wins
      }
      await resource.update(mutation.objectId!, mutation.data);
    }
  },
  onMutationFailed: (mutation, error) => console.error(mutation, error),
  onSyncComplete: () => console.log("done"),
});
```

[Optimistic locking (ETags)](../core/optimistic-locking.md) surfaces server-side conflicts as `412`s you can reconcile.

## Without React

```typescript
import { createLiveQuery } from "covara/client";

const liveQuery = createLiveQuery(client.resource<Todo>("/todos"), { orderBy: "createdAt:desc" });
liveQuery.subscribe(() => render(liveQuery.getSnapshot()));
liveQuery.mutate.create({ text: "x", completed: false });
liveQuery.destroy();
```

## Limitations

- Read operations require the network (cache separately if needed).
- Batch operations are not queued (single-item mutations only).
- Subscription events are lost while offline (a full sync runs on reconnect).
- Optimistic IDs are temporary and change after sync (handle via `onIdRemapped`).

## Related

- [Live queries](./live-queries.md) · [Optimistic locking](../core/optimistic-locking.md) · [React hooks](./react-hooks.md)
- [Offline-sync contract](../contracts/offline-sync.md)
