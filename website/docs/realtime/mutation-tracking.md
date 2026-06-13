---
id: mutation-tracking
title: Mutation tracking
sidebar_label: Mutation tracking
description: Wrap your Drizzle db with trackMutations so custom routes, procedures, transactions, raw SQL, and external writers all feed the changelog, subscriptions, and query cache automatically.
---

# Mutation tracking

`trackMutations` wraps a Drizzle database so that **every mutation — even from custom routes — records to the [changelog](./changelog.md), pushes to [subscribers](./subscriptions.md), and invalidates the query cache** automatically. Generated resource endpoints already do this; `trackMutations` extends it to your own code.

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { trackMutations } from "covara";
import * as schema from "./schema";

const baseDb = drizzle(/* ... */);

export const db = trackMutations(baseDb, {
  todos: { table: schema.todosTable, id: schema.todosTable.id },
  users: { table: schema.usersTable, id: schema.usersTable.id },
});

await db.insert(schema.todosTable).values({ title: "New" }).returning();
// ^ recorded in the changelog, subscribers notified
```

## How it works

A `Proxy` intercepts mutations at two fidelity levels:

| Pattern | `previousObject` | Subscription event |
|---------|------------------|--------------------|
| `db.insert(t).values(d).returning()` | n/a | `added` |
| `db.update(t).set(d).where(...).returning()` | captured | `changed` |
| `db.delete(t).where(...)` | captured | `removed` |
| `db.run(sql\`INSERT ...\`)` / `db.execute(...)` | no | `invalidate` |
| `db.batch([...])` | no | `invalidate` (per detected statement) |
| `recordExternalMutation(...)` | no | `invalidate` |

Builder-pattern mutations get full row-level events; raw SQL and batch statements are detected by introspecting compiled SQL and recorded as a coarse `invalidate` (`objectId: "*"`).

## Configuration

```typescript
const trackedDb = trackMutations(baseDb, tables, {
  onMutation: (entry) => {},                 // builder-pattern mutations
  onRawSqlMutation: (resource, type) => {},  // raw SQL mutations
  skipTables: ["audit_logs", "sessions"],
  trackTransactions: true,    // default true
  capturePreviousState: true, // default true
  pushToSubscriptions: true,  // default true
  cache: { enabled: true, ttl: 60000 },      // query cache (below)
});
```

### Table registration

```typescript
trackMutations(baseDb, {
  todos: { table: todosTable, id: todosTable.id },
  users: { table: usersTable, id: usersTable.id, resourceName: "api-users" }, // custom name
});
```

## In procedures

The `ctx.db` passed to [procedure handlers](../core/procedures.md) is automatically tracked for the current resource. For multi-table procedures, pass a pre-wrapped tracked db as `config.db` (it won't be double-wrapped). See [Procedures](../core/procedures.md#multi-table-tracking).

## Custom routes

```typescript
import { requireUser } from "covara";

app.post("/api/custom-action", async (c) => {
  const user = requireUser(c);
  const [todo] = await db.insert(todosTable).values({ title: "x", userId: user.id }).returning();
  return c.json(todo); // tracked, subscribers notified
});
```

## Transactions (commit-gated)

```typescript
await db.transaction(async (tx) => {
  const [todo] = await tx.insert(todosTable).values({ title: "Todo" }).returning();
  await tx.update(usersTable).set({ todoCount: sql`todoCount + 1` }).where(eq(usersTable.id, userId));
});
```

Side effects (changelog entries, subscription pushes, cache invalidations) are **buffered and only emitted after commit**. If the callback throws and rolls back, buffered effects are discarded — subscribers never see an event for state that was never persisted. Likewise, a failed mutation records nothing.

## Disable tracking temporarily

```typescript
await db.withoutTracking(async (db) => {
  await db.insert(auditLogsTable).values({ action: "login" }); // not tracked
});
```

## Notifying external writers

When something outside the tracked db mutates a table — a cron job, another service, a manual edit, or a CDC pipeline — call `recordExternalMutation`. It appends a changelog entry, invalidates the cache, and sends subscribers an `invalidate`:

```typescript
import { recordExternalMutation } from "covara";

await recordExternalMutation("todos", "update", { objectId: "todo-1" });
await recordExternalMutation("todos", "delete"); // objectId defaults to "*"
```

This is the portable alternative to database-specific change data capture. For cross-instance fan-out, initialize a distributed [KV](../platform/kv.md).

## Query caching

Cache `SELECT` queries with automatic invalidation on mutation:

```typescript
const db = trackMutations(baseDb, tables, {
  cache: {
    enabled: true,
    ttl: 60000,
    keyPrefix: "cache:",
    tables: { todos: { ttl: 30000 }, users: { enabled: false } },
  },
});
```

**Join-aware invalidation:** a cached query is tagged with **every** table it references (including joined tables), so a mutation to any of them invalidates the result — not just the `FROM` table.

```typescript
import { invalidateCache, invalidateAllCache } from "covara";
await invalidateCache("todos");
await invalidateAllCache();
```

## Avoiding double-tracking

When both `trackMutations` and `useResource` operate on the same table, `useResource` already records its own changelog entries. Use `withoutTracking` for internal DB calls in hooks that shouldn't be tracked separately.

## API reference

```typescript
function trackMutations<TDb>(db: TDb, tables: Record<string, TableRegistration>, config?: TrackMutationsConfig): TrackedDatabase<TDb>;

interface TableRegistration { table: Table; id: AnyColumn; resourceName?: string }

interface TrackedDatabase<TDb> extends TDb {
  withoutTracking<T>(fn: (db: TDb) => Promise<T>): Promise<T>;
}
```

## Related

- [Changelog](./changelog.md) · [Subscriptions](./subscriptions.md) · [Procedures](../core/procedures.md)
- [Track-mutations contract](../contracts/track-mutations.md)
