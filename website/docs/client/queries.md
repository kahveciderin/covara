---
id: queries
title: Queries & repository
sidebar_label: Queries & repository
description: Typed resource CRUD, batch and RPC calls, aggregations, and the immutable fluent query builder with select-narrowed return types and escaped filter helpers.
---

# Queries & repository

`client.resource<T>(path)` returns a typed repository for one endpoint. It exposes direct CRUD methods plus a fluent, type-narrowing `query()` builder.

```typescript
interface Todo { id: string; title: string; completed: boolean }
const todos = client.resource<Todo>("/api/todos");
```

## CRUD

```typescript
const { items, hasMore, nextCursor } = await todos.list({
  filter: "completed==false",
  orderBy: "createdAt:desc",
  limit: 20,
  cursor: nextCursor,
  select: ["id", "title"],
  include: "category,tags",
  totalCount: true,
});

const todo = await todos.get("todo-123", { select: ["id", "title"] });
const created = await todos.create({ title: "Buy groceries", completed: false });
const updated = await todos.update("todo-123", { completed: true });
await todos.delete("todo-123");
```

For offline/optimistic mutations pass `{ optimistic: true }` or `{ optimisticId }` — see [Offline](./offline.md).

## Batch & RPC

```typescript
await todos.batchCreate([{ title: "A" }, { title: "B" }]);
const { count } = await todos.batchUpdate("completed==false", { completed: true });
await todos.batchDelete("completed==true");

const result = await todos.rpc<{ ids: string[] }, { archived: number }>("archive", { ids: ["1", "2"] });
```

See [Batch operations](../core/batch.md) and [Procedures](../core/procedures.md).

## Aggregations

```typescript
const stats = await todos.aggregate({ groupBy: ["completed"], count: true });
// { groups: [{ key: { completed: true }, count: 5 }, ...] }
```

## The query builder

`query()` is an **immutable**, chainable builder with full type inference. `select` narrows the return type to exactly the chosen fields.

```typescript
const { items } = await users.query().select("id", "name").list();
items[0].name;  // ✓
items[0].email; // ✗ type error — not selected
```

```typescript
const activeUsers = await users
  .query()
  .select("id", "name", "email")
  .filter("age>=18")
  .filter('role=="user"')   // filters AND together
  .orderBy("name:asc")
  .limit(10)
  .list();

const user = await users.query().select("id", "name").get("user-123");
const newest = await users.query().orderBy("createdAt:desc").first();   // T | null
const adultCount = await users.query().filter("age>=18").count();       // number
```

Each method returns a **new** builder, so a base query can branch:

```typescript
const base = users.query().filter("age>=18");
const admins = base.filter('role=="admin"');
const regular = base.filter('role=="user"'); // base unchanged
```

### Builder methods

| Method | Description |
|--------|-------------|
| `select(...fields)` | Narrow returned fields (and type). |
| `filter(f)` / `where(f)` | Add a filter (AND). |
| `orderBy(s)` · `limit(n)` · `cursor(c)` · `include(s)` | List options. |
| `withTotalCount()` | Request the total count. |
| `groupBy(...)` · `withCount()` · `sum/avg/min/max(...)` | Aggregation. |
| `list()` · `get(id)` · `first()` · `count()` · `aggregate()` | Execute. |

### Type-safe aggregations

```typescript
const stats = await users
  .query()
  .groupBy("role")
  .withCount()
  .avg("age")        // numeric fields only
  .sum("score")
  .min("name")       // comparable fields
  .max("createdAt")
  .aggregate();
// typed: { groups: [{ key: { role }, count, avg: { age }, sum: { score }, min: { name }, max: { createdAt } }] }
```

## Filter helpers

Instead of hand-writing [RSQL](../core/filtering.md), build it with `q` (values escaped automatically):

```typescript
import { q } from "covara/client";

const filter = q.and(
  q.gte("age", 18),
  q.or(q.eq("role", "user"), q.eq("role", "admin")),
  q.contains("name", "jo"),
);
const adults = await users.query().filter(filter).list();
```

Builders: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `notLike`, `ilike`, `in`, `out`, `isNull`, `isNotNull`, `startsWith`, `endsWith`, `contains`, `icontains`, `between`, `and`, `or`, `raw`. There is no `q.not` — use the negated operators.

### Typed filter builder `f<T>()`

For compile-time field/value checking:

```typescript
import { f } from "covara/client";

const filter = f<Todo>().and(
  f<Todo>().eq("completed", false),   // must be a boolean field of Todo
  f<Todo>().gte("createdAt", since),
);
// f<Todo>().eq("complted", false)    // ✗ type error: not a key of Todo
```

It emits the same RSQL as `q`, so it drops straight into `.filter(...)`.

## Generated field-metadata types

[Type generation](./typegen.md) emits helpers for type-safe field references:

```typescript
export type UserFields = "id" | "name" | "email" | "age" | "role";
export type UserNumericFields = "age" | "score";
export type UserComparableFields = "id" | "name" | "email" | "age" | "createdAt";
```

## Related

- [React hooks](./react-hooks.md) · [Type generation](./typegen.md) · [Filtering](../core/filtering.md)
- [Pagination](../core/pagination.md) · [Aggregations](../core/aggregations.md)
