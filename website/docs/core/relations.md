---
id: relations
title: Relations & joins
sidebar_label: Relations
description: Define belongsTo, hasOne, hasMany, and manyToMany relations and load them efficiently with batch loading, include options, eager strategies, nested includes, and subscription support.
---

# Relations & joins

Covara loads related data with **batch loading** to avoid N+1 queries: one query for the parents, then one query per relation using `IN (...)`. Relations are declared per resource and loaded via the `?include=` query parameter.

## Relation types

| Type | Description | Example |
|------|-------------|---------|
| `belongsTo` | Foreign key on **this** table | A post belongs to a user |
| `hasOne` | Foreign key on the **related** table (1:1) | A user has one profile |
| `hasMany` | Foreign key on the **related** table (1:N) | A user has many posts |
| `manyToMany` | Junction table | A post has many tags |

## Defining relations

```typescript
useResource(postsTable, {
  db,
  id: postsTable.id,
  relations: {
    author: {
      resource: "users",
      schema: usersTable,
      type: "belongsTo",
      foreignKey: postsTable.authorId,
      references: usersTable.id,
      defaultSelect: [usersTable.id, usersTable.name, usersTable.avatar], // limit fields returned (columns of the related table)
    },
    comments: {
      resource: "comments",
      schema: commentsTable,
      type: "hasMany",
      foreignKey: commentsTable.postId,
      references: postsTable.id,
    },
    tags: {
      resource: "tags",
      schema: tagsTable,
      type: "manyToMany",
      foreignKey: postsTable.id,
      references: tagsTable.id,
      through: {
        schema: postTagsTable,
        sourceKey: postTagsTable.postId,
        targetKey: postTagsTable.tagId,
      },
    },
  },
});
```

### Relation config

```typescript
interface RelationConfig {
  resource: string;            // resource name (used for nested loading)
  schema: Table;               // Drizzle table
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  foreignKey: AnyColumn;
  references: AnyColumn;
  through?: { schema: Table; sourceKey: AnyColumn; targetKey: AnyColumn }; // manyToMany only
  strategy?: "eager" | "lazy"; // eager auto-loads on list/get; default lazy
  defaultSelect?: string[];
  filterable?: boolean;        // allow filtering parents by this relation
  subscribeToChanges?: boolean;// include in subscription events
}
```

## Auto-discovery

Set `autoRelations: true` to derive relations from your Drizzle foreign keys instead of declaring them by hand:

```typescript
useResource(postsTable, { db, id: postsTable.id, autoRelations: true });
```

- **`belongsTo`** is discovered from this table's own single-column FKs — `posts.authorId → users.id` becomes a relation named `author` (the FK column name with a trailing `Id`/`_id` stripped).
- **`hasMany`** is discovered from other **registered resources** whose FKs reference this table — if `comments.postId → posts.id`, `posts` gains a relation named after the referencing table (`comments`).
- Only single-column FKs to registered resources are discovered — no guessing. `manyToMany`, custom names, eager strategy, and `defaultSelect` must be declared explicitly.
- **Explicit `relations` always win** over a discovered relation of the same name, so you can enable `autoRelations` and still override or add specific ones.
- Discovered relations are **lazy** (loaded only via `?include=`) and run through the same scope-enforced loader as explicit relations (see [Scope enforcement](#scope-enforcement)).

## Including relations

```bash
GET /api/posts?include=author                              # single
GET /api/posts?include=author,category,tags                # multiple
GET /api/posts?include=author.profile                      # nested
GET /api/posts?include=comments(limit:5;select:id,text)    # with options
```

### Include options

| Option | Description | Example |
|--------|-------------|---------|
| `limit` | Max items **per parent** (`hasMany`/`manyToMany`) | `comments(limit:10)` |
| `offset` | Skip items per parent | `comments(limit:10;offset:10)` |
| `select` | Fields to include | `author(select:id,name)` |
| `filter` | [RSQL filter](./filtering.md) on related rows | `comments(filter:status=="approved")` |

`limit`/`offset` apply **per parent row**, so each parent gets its own page of children. The `filter` is combined with the relation's join condition.

## Scope enforcement

Included relations honor the **target resource's `read` [auth scope](../auth/scopes.md)** for the requesting user — a relation can never reveal rows the user could not read by querying that resource directly. For each included relation, the target resource's read scope is resolved for the effective user (including an [impersonated](../tooling/admin-ui.md) one) and AND-ed into the relation query: rows outside the user's scope are filtered out (`belongsTo`/`hasOne` becomes `null`; `hasMany`/`manyToMany` omits them), and a user denied read on the target resource gets nothing. This applies identically to explicit and [auto-discovered](#auto-discovery) relations.

Relations to tables that are **not** registered as resources have no scope to enforce — only expose such relations to data you intend to be readable through the parent.

> **Subscriptions:** relations embedded in [subscription](../realtime/subscriptions.md) events **are** scope-filtered per subscriber — the target resource's `read` scope is resolved for each subscriber's user (captured at subscribe time) and applied to the embedded relation, exactly as on the read path. A relation in a subscription event can never reveal rows that subscriber couldn't read directly. (Relations are loaded per subscriber rather than shared across them, so the cost scales with subscriber count; loads are deduplicated per subscriber within a single push.)

### Eager relations

A relation with `strategy: "eager"` loads automatically on `GET /` and `GET /:id` without `?include=`. If the client also requests it explicitly, the explicit spec (filter/limit/offset/select/nested) wins.

```typescript
relations: {
  author: { /* ... */ strategy: "eager" },
}
```

### Include limits

```typescript
useResource(postsTable, {
  db,
  id: postsTable.id,
  relations: { /* ... */ },
  include: {
    maxDepth: 3,              // max nesting depth (default 3)
    defaultLimit: 100,        // default per-parent limit for hasMany
    allowNestedFilters: true, // allow filters on nested relations
  },
});
```

## Filtering parents by relation

```bash
GET /api/posts?filter=tags.name=="TypeScript"
GET /api/posts?filter=author.organizationId=="org-123"
```

This requires `filterable: true` on the relation and may use subqueries — index accordingly on large tables.

## Relations in subscriptions

Includes work with [subscriptions](../realtime/subscriptions.md): related data is attached to `added`/`changed` events.

```typescript
posts.subscribe(
  { filter: 'status=="published"', include: "author,tags" },
  {
    onAdded: (post) => console.log("New post by", post.author.name),
    onChanged: (post) => { /* related data included */ },
  }
);
```

## Nested write-through

With [`nestedWrites: true`](./nested-writes.md), a `POST` body can embed related objects to create them atomically. See **[Nested writes](./nested-writes.md)** for the full transaction order and limitations (`manyToMany` is not supported for nested writes).

## TypeScript

```typescript
import type { RelationType, RelationConfig, IncludeSpec } from "covara";
```

The [typed client](../client/typegen.md) infers included relations into the result type — `posts.include("author", "tags")` returns rows with typed `author` and `tags`.

## Related

- [Nested writes](./nested-writes.md) · [Filtering](./filtering.md) · [Subscriptions](../realtime/subscriptions.md)
- [Client queries](../client/queries.md) — the fluent `.include()` builder
