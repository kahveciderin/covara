# Offline Support

Covara's client library supports offline-first applications with optimistic updates, mutation queueing, and automatic synchronization.

## Overview

When your application goes offline:
1. Read operations fail (or use cached data)
2. Mutations are queued locally with optimistic updates
3. Queued mutations sync automatically when online
4. The `useLiveList` hook handles all of this automatically

## Quick Start

The simplest way to enable offline support is with `offline: true`:

```typescript
import { getOrCreateClient } from "covara/client";
import { useLiveList } from "covara/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,  // Uses LocalStorage with sensible defaults
});

function TodoApp() {
  const { items, status, statusLabel, mutate, pendingCount } = useLiveList<Todo>(
    "/api/todos",
    { orderBy: "position" }
  );

  // Mutations work offline automatically
  const addTodo = () => {
    mutate.create({ title: "New todo" });  // Instant optimistic update
  };

  return (
    <div>
      <ul>
        {items.map(todo => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
      <button onClick={addTodo}>Add</button>
      <footer>{statusLabel}</footer>  {/* "Live", "Offline (2 pending)", etc. */}
    </div>
  );
}
```

## Setup

### Simple Configuration

```typescript
import { createClient } from "covara/client";

// Just pass offline: true for sensible defaults
const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: true,  // Uses LocalStorage("covara-mutations")
  onError: (error) => console.error("Sync error:", error),
  onSyncComplete: () => console.log("All changes synced"),
});
```

### Advanced Configuration

For fine-grained control, pass an object:

```typescript
import { createClient, LocalStorageOfflineStorage } from "covara/client";

const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("my-app-offline"),
    maxRetries: 5,
    retryDelay: 2000,
    onIdRemapped: (optimisticId, serverId) => {
      // Called when temporary IDs are replaced with server IDs
      console.log(`ID changed: ${optimisticId} -> ${serverId}`);
    },
  },
  onError: (error) => {
    console.error("Sync error:", error);
  },
});
```

### Custom Storage

Or implement your own storage (e.g., IndexedDB):

```typescript
import { OfflineStorage, OfflineMutation } from "covara/client";

class IndexedDBStorage implements OfflineStorage {
  async getMutations(): Promise<OfflineMutation[]> { /* ... */ }
  async addMutation(mutation: OfflineMutation): Promise<void> { /* ... */ }
  async updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void> { /* ... */ }
  async removeMutation(id: string): Promise<void> { /* ... */ }
  async clear(): Promise<void> { /* ... */ }
}
```

## Optimistic Updates

Enable optimistic updates by passing `{ optimistic: true }`:

```typescript
const users = client.resource<User>("/users");

// Create - returns immediately with temporary ID
const newUser = await users.create(
  { name: "Alice", email: "alice@example.com" },
  { optimistic: true }
);
console.log(newUser.id); // "optimistic_1704067200000"

// Update - returns immediately with optimistic data
const updated = await users.update(
  "123",
  { name: "Alice Smith" },
  { optimistic: true }
);

// Delete - returns immediately
await users.delete("123", { optimistic: true });
```

## Mutation Queue

### Viewing Pending Mutations

```typescript
const pending = await client.offline?.getPendingMutations();
console.log(pending);
// [
//   { id: "abc", type: "create", resource: "/users", data: {...}, status: "pending" },
//   { id: "def", type: "update", resource: "/users", data: {...}, status: "failed", retryCount: 1 }
// ]
```

### Manual Sync

```typescript
// Trigger sync manually
await client.offline?.syncPendingMutations();
```

### Clear Queue

```typescript
// Clear all pending mutations (use with caution!)
await client.offline?.clearMutations();
```

## Mutation Lifecycle

Each mutation goes through these states:

| State | Description |
|-------|-------------|
| `pending` | Waiting to be synced |
| `processing` | Currently being synced |
| `failed` | Sync failed, will retry |

## Error Handling

Handle sync errors through callbacks:

```typescript
const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: {
    enabled: true,
  },
  onError: (error) => {
    // Called when a mutation fails to sync
    console.error("Sync failed:", error);

    // Show user notification
    toast.error("Failed to sync changes. Will retry...");
  },
});
```

For more granular control, use the OfflineManager directly:

```typescript
import { createOfflineManager, InMemoryOfflineStorage } from "covara/client";

const offlineManager = createOfflineManager({
  config: {
    enabled: true,
    maxRetries: 5,
    storage: new InMemoryOfflineStorage(),
  },
  onMutationSync: async (mutation) => {
    // Called for each mutation being synced
    // Implement your sync logic here
    console.log("Syncing:", mutation);
  },
  onMutationFailed: (mutation, error) => {
    // Called when a mutation fails
    console.error("Failed:", mutation, error);
  },
  onSyncComplete: () => {
    // Called when sync cycle completes
    console.log("Sync complete");
  },
});
```

## Offline Detection

```typescript
// Check current online status
const isOnline = client.offline?.getIsOnline();

// The client automatically listens to browser online/offline events
// and syncs when coming back online
```

## Example: Offline-First Todo App

### With React Hooks (Recommended)

The `useLiveList` hook handles all offline logic automatically:

```typescript
import { getOrCreateClient } from "covara/client";
import { useLiveList } from "covara/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  offline: true,
});

function TodoApp() {
  const { items: todos, status, statusLabel, mutate, pendingCount } = useLiveList<Todo>(
    "/api/todos",
    { orderBy: "createdAt:desc" }
  );

  // All mutations automatically:
  // - Update UI instantly (optimistic)
  // - Queue when offline
  // - Sync when back online
  // - Handle ID remapping

  const addTodo = (text: string) => {
    mutate.create({ text, completed: false });
  };

  const toggleTodo = (id: string, completed: boolean) => {
    mutate.update(id, { completed: !completed });
  };

  const deleteTodo = (id: string) => {
    mutate.delete(id);
  };

  return (
    <div>
      <ul>
        {todos.map(todo => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id, todo.completed)}
            />
            {todo.text}
            <button onClick={() => deleteTodo(todo.id)}>×</button>
          </li>
        ))}
      </ul>
      <footer>
        {statusLabel}
        {pendingCount > 0 && ` • ${pendingCount} pending`}
      </footer>
    </div>
  );
}
```

### Without React (Low-Level API)

For non-React apps or custom integrations:

```typescript
import { createClient, createLiveQuery, LocalStorageOfflineStorage } from "covara/client";

const client = createClient({
  baseUrl: "/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("todos"),
  },
});

const todos = client.resource<Todo>("/todos");

// Create a live query store
const liveQuery = createLiveQuery(todos, { orderBy: "createdAt:desc" });

// Subscribe to changes
liveQuery.subscribe(() => {
  const state = liveQuery.getSnapshot();
  renderTodos(state.items);
  renderStatus(state.status, state.pendingCount);
});

// Mutations work the same way
function addTodo(text: string) {
  liveQuery.mutate.create({ text, completed: false });
}

function toggleTodo(id: string, completed: boolean) {
  liveQuery.mutate.update(id, { completed: !completed });
}

function deleteTodo(id: string) {
  liveQuery.mutate.delete(id);
}

// Cleanup when done
liveQuery.destroy();
```

### Manual Approach (Full Control)

For complete control over offline behavior:

```typescript
const client = createClient({
  baseUrl: "/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("todos"),
  },
});

const todos = client.resource<Todo>("/todos");

// Load initial data
async function loadTodos() {
  try {
    const result = await todos.list();
    return result.items;
  } catch (error) {
    console.log("Offline - using cached data");
    return [];
  }
}

// Create with optimistic ID
async function addTodo(text: string) {
  return await todos.create(
    { text, completed: false },
    { optimisticId: `temp_${Date.now()}` }
  );
}

// Update
async function toggleTodo(id: string, completed: boolean) {
  return await todos.update(id, { completed: !completed });
}

// Delete
async function deleteTodo(id: string) {
  await todos.delete(id);
}
```

## Conflict Resolution

When syncing optimistic mutations, conflicts may occur if the server state has changed. Handle conflicts in your sync logic:

```typescript
const offlineManager = createOfflineManager({
  config: { enabled: true },
  onMutationSync: async (mutation) => {
    try {
      if (mutation.type === "update") {
        // Fetch current server state
        const current = await resource.get(mutation.objectId!);

        // Check for conflicts
        if (current.updatedAt > mutation.timestamp) {
          // Server has newer data - handle conflict
          // Option 1: Server wins
          return;

          // Option 2: Client wins
          // Continue with update

          // Option 3: Merge
          // Merge changes and update
        }

        await resource.update(mutation.objectId!, mutation.data);
      }
      // ... handle other mutation types
    } catch (error) {
      throw error; // Will trigger retry
    }
  },
});
```

## Best Practices

1. **Use optimistic updates for UX** - Users see immediate feedback
2. **Show sync status** - Indicate when mutations are pending
3. **Handle conflicts gracefully** - Don't lose user data
4. **Persist mutations** - Use LocalStorage or IndexedDB for reliability
5. **Set reasonable retry limits** - Avoid infinite retry loops
6. **Provide manual retry** - Let users trigger sync manually
7. **Clear old mutations** - Clean up completed/failed mutations periodically

## Limitations

- Read operations require network (consider caching separately)
- Batch operations are not queued (single-item operations only)
- Subscription events are lost while offline
- Optimistic IDs are temporary and change after sync
