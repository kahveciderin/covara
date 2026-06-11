# Subscriptions

Covara provides real-time subscriptions via Server-Sent Events (SSE).

## Quick Start with React

The easiest way to use subscriptions is with the `useLiveList` hook:

```typescript
import { getOrCreateClient } from "covara/client";
import { useLiveList } from "covara/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
});

function UserList() {
  const { items, status, statusLabel, mutate } = useLiveList<User>(
    "/api/users",
    { filter: 'status=="active"' }
  );

  // items automatically updates in real-time
  // status: "loading" | "live" | "reconnecting" | "offline" | "error"

  return (
    <div>
      <div>Status: {statusLabel}</div>
      <ul>
        {items.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Server Setup

Subscriptions are automatically available at `/subscribe`:

```bash
curl -N "http://localhost:3000/users/subscribe"
```

## Low-Level Client API

For non-React usage or more control:

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({ baseUrl: "http://localhost:3000" });
const users = client.resource<User>("/users");

const subscription = users.subscribe(
  { filter: 'status=="active"' },
  {
    onAdded: (user, meta) => {
      console.log("Added:", user);
      // meta.optimisticId available if this was from an optimistic create
    },
    onChanged: (user) => console.log("Changed:", user),
    onRemoved: (id) => console.log("Removed:", id),
    onConnected: (seq) => console.log("Connected at sequence:", seq),
    onDisconnected: () => console.log("Disconnected"),
    onInvalidate: () => console.log("Cache invalidated"),
    onError: (error) => console.error("Error:", error),
  }
);

// Reconnect after disconnect
subscription.reconnect();

// Resume from a specific sequence
subscription.resumeFrom(lastSeq);

// Cleanup
subscription.unsubscribe();
```

## Event Types

### `existing`
Sent for each existing item when first subscribing:
```json
{
  "type": "existing",
  "seq": 1,
  "object": { "id": "1", "name": "John" }
}
```

### `added`
Sent when a new item is created that matches the filter:
```json
{
  "type": "added",
  "seq": 2,
  "object": { "id": "2", "name": "Jane" }
}
```

### `changed`
Sent when an item is updated:
```json
{
  "type": "changed",
  "seq": 3,
  "object": { "id": "1", "name": "John Updated" }
}
```

### `removed`
Sent when an item is deleted or no longer matches the filter:
```json
{
  "type": "removed",
  "seq": 4,
  "objectId": "1"
}
```

### `invalidate`
Sent when the client needs to refetch all data:
```json
{
  "type": "invalidate",
  "seq": 5,
  "reason": "Sequence gap - please refetch"
}
```

## Hybrid Subscriptions (Efficient Large Datasets)

For large datasets, the default behavior of sending all existing items on connect can be inefficient. Covara supports a **hybrid approach** where you:

1. Fetch initial data via paginated GET
2. Subscribe with `skipExisting=true` to receive only changes

### How `useLiveList` Works

The `useLiveList` hook automatically uses this hybrid approach:

```typescript
// Internally, useLiveList:
// 1. Fetches data via paginated GET
// 2. Subscribes with skipExisting=true and passes the IDs it knows about
// 3. Only receives added/changed/removed events - no duplicate data transfer
```

### Manual Hybrid Subscription

For more control, use the low-level API:

```typescript
const users = client.resource<User>("/users");

// Step 1: Fetch initial data via paginated GET
const { items } = await users.list({ limit: 20, orderBy: "name" });

// Step 2: Subscribe with skipExisting, passing known IDs
const subscription = users.subscribe(
  {
    skipExisting: true,
    knownIds: items.map(item => item.id),
  },
  {
    onAdded: (user) => console.log("New user:", user),
    onChanged: (user) => console.log("Updated:", user),
    onRemoved: (id) => console.log("Deleted:", id),
  }
);
```

### Server Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `skipExisting` | boolean | Skip sending existing items on connect |
| `knownIds` | string (comma-separated) | IDs the client already knows about |

### How It Works

When `skipExisting=true`:
- No `existing` events are sent
- If `knownIds` are provided, they're registered for change tracking
- If no `knownIds`, the server queries matching items to register their IDs

This ensures:
- **`added` events** are sent for new items matching the filter
- **`changed` events** are sent when known items are updated
- **`removed` events** are sent when known items are deleted or leave filter scope

## Changelog-Based Subscriptions

Covara uses a changelog-based approach for reliable subscriptions:

1. Every mutation is recorded with a sequence number
2. Clients track their last received sequence
3. On reconnection, clients can resume from their last sequence
4. If too many changes occurred, an invalidate event is sent

### Mutations in Custom Routes

Mutations made via `useResource` endpoints are automatically recorded to the changelog. For custom Hono routes, wrap your database with `trackMutations` to ensure mutations are tracked:

```typescript
import { trackMutations } from "covara";

const db = trackMutations(baseDb, {
  todos: { table: todosTable, id: todosTable.id },
});

// Custom route - mutations automatically tracked and push to subscribers
app.post("/api/custom-action", async (c) => {
  const body = await c.req.json<{ title: string }>();
  const [todo] = await db.insert(todosTable)
    .values({ title: body.title })
    .returning();
  return c.json(todo);
});
```

See [Mutation Tracking](./track-mutations.md) for full documentation.

### Reconnection

```typescript
const subscription = users.subscribe({
  resumeFrom: lastSeq,  // Resume from last known sequence
});
```

## Filter Updates

When an item is updated and moves in/out of the filter:

- **Enters filter**: Client receives an `added` event
- **Stays in filter**: Client receives a `changed` event
- **Leaves filter**: Client receives a `removed` event

## Authentication

Subscriptions respect auth scopes. If a user's auth expires:

```json
{
  "type": "invalidate",
  "reason": "Authentication expired"
}
```

## Connection Management

The subscription manager handles:
- Automatic reconnection with exponential backoff (with jitter to avoid thundering-herd reconnects)
- Heartbeat to detect connection issues
- Cleanup on page unload

## Backpressure (Slow Consumers)

Each SSE connection has a bounded outbound queue. When a consumer can't keep up and the
queue fills, the server applies the resource's backpressure policy instead of buffering
without limit:

```typescript
useResource(todos, {
  db,
  id: todos.id,
  sse: {
    maxQueueBytes: 65536,          // outbound buffer high-water mark (default 64 KB)
    onBackpressure: "invalidate",  // "invalidate" (default) | "disconnect" | "drop"
  },
});
```

- `"invalidate"` (default) — send a single `invalidate` event so the client refetches and resumes from a consistent state.
- `"disconnect"` — close the connection; the client reconnects and resumes from its last sequence.
- `"drop"` — silently skip the event for this connection (it may miss updates until the next full sync).

`maxSubscriptionsPerUser`, `maxSubscriptionsPerIP`, `maxTotalSubscriptions`, and
`heartbeatMs` are also configurable under `sse`.

## Multiple Instances

Subscriptions work across instances when every instance shares a distributed KV store
(Redis or the Durable Object KV) and the store is initialized with `initializeKV` — which
auto-wires cross-process event fan-out, so a mutation on one instance reaches subscribers
connected to another. See [Deployment → Scaling Across Instances](./deployment.md#scaling-across-instances).

## Paginated Subscriptions with Subscription Modes

When using `useLiveList` with pagination (`limit`), you need to control how real-time updates interact with your paginated view. By default, the server sends events for ALL items matching the filter, not just the visible page.

### The Problem

Without subscription modes:
1. Client fetches first 5 items via GET
2. Client subscribes with `skipExisting=true`
3. Another user creates a new item matching the filter
4. Client receives `added` event and shows 6 items - pagination broken!

### Subscription Modes

Use `subscriptionMode` to control this behavior:

| Mode | New Items | Updated Items | Removed Items | Use Case |
|------|-----------|---------------|---------------|----------|
| `strict` | Only own creates | Only cached items | Cached items | Tables, admin dashboards |
| `sorted` | Show (in sort order) | Only cached items | Cached items | Collaborative lists, kanban boards |
| `append` | Show (at end) | Only cached items | Cached items | Chat, activity logs |
| `prepend` | Show (at start) | Only cached items | Cached items | Notifications, news feeds |
| `live` | Show all | Show all | All known | Real-time dashboards |

**Default**: `strict` when `limit` is set, `live` otherwise.

### Usage Examples

```typescript
// Strict mode (default for paginated) - only show fetched items + own creates
const { items } = useLiveList<Todo>('/api/todos', {
  limit: 10,
  // subscriptionMode: "strict" is implicit when limit is set
});

// Sorted mode - show new items in correct sort position
const { items } = useLiveList<Task>('/api/tasks', {
  limit: 20,
  subscriptionMode: "sorted",
  orderBy: "priority:desc,createdAt:desc"
});

// Append mode - show new items at end (like a chat log)
const { items } = useLiveList<Message>('/api/messages', {
  limit: 50,
  subscriptionMode: "append",
  orderBy: "createdAt:asc"
});

// Prepend mode - show new items at start (like notifications)
const { items } = useLiveList<Notification>('/api/notifications', {
  limit: 20,
  subscriptionMode: "prepend",
  orderBy: "createdAt:desc"
});

// Live mode - show everything (explicit override for paginated)
const { items } = useLiveList<Alert>('/api/alerts', {
  limit: 20,
  subscriptionMode: "live"  // Override default strict
});
```

### Mode Behavior Details

**Strict Mode** (default for paginated):
- New items from other clients are NOT added to the list
- Your own creates appear immediately (optimistic updates)
- Updates to cached items are applied
- Removes work for cached items

**Sorted Mode**:
- New items from other clients appear in the correct sort position
- Useful for collaborative editing where you want to see others' additions

**Append/Prepend Mode**:
- New items appear at the end/start regardless of sort order
- Useful for chronological feeds where new items should be visible

**Live Mode** (default for non-paginated):
- All events are processed - the "see everything" mode
- Use this for real-time dashboards or when showing all items

## Relations in Subscriptions

Subscriptions support the `include` parameter to receive related data in events:

```bash
GET /api/todos/subscribe?include=category,tags
```

When configured, `added` and `changed` events include the related objects:

```json
{
  "type": "changed",
  "seq": 5,
  "object": {
    "id": "1",
    "title": "Buy groceries",
    "categoryId": "cat-1",
    "category": {
      "id": "cat-1",
      "name": "Shopping",
      "color": "#00ff00"
    },
    "tags": [
      { "id": "tag-1", "name": "urgent" }
    ]
  }
}
```

### Using with useLiveList

The `include` option is passed to both the initial GET and the subscription:

```typescript
const { items } = useLiveList<TodoWithRelations>('/api/todos', {
  include: 'category,tags',
  orderBy: 'position',
});

// items[0].category is available
// items[0].tags is available
```

### Optimistic Updates and Relations

When you update a foreign key (e.g., changing `categoryId`), the optimistic update clears the stale relation immediately:

```typescript
// Before: { categoryId: "cat-1", category: { name: "Work" } }
mutate.update(todo.id, { categoryId: "cat-2" });
// Immediately after: { categoryId: "cat-2", category: undefined }
// After server confirms: { categoryId: "cat-2", category: { name: "Personal" } }
```

For instant UI updates, you can look up relations from locally cached data:

```typescript
function TodoItem({ todo, categories }) {
  // Use included relation if available, otherwise look up locally
  const category = todo.category ?? categories.find(c => c.id === todo.categoryId);

  return (
    <div>
      {todo.title}
      {category && <span style={{ color: category.color }}>{category.name}</span>}
    </div>
  );
}
```
