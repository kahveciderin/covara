---
id: nested-writes
title: Nested write-through
sidebar_label: Nested writes
description: Create belongsTo parents and hasMany/hasOne children together with the main row in a single atomic POST, with foreign keys wired automatically.
---

# Nested write-through

With `nestedWrites: true`, a `POST /` body may embed related objects under their [relation](./relations.md) names. They are created together with the main row in a **single transaction**, with foreign keys wired automatically. If any insert fails, the whole transaction rolls back.

`nestedWrites` is off by default and requires `relations` to be configured.

:::caution Cloudflare D1
D1 has no interactive transactions, and a nested write chains inserts whose generated ids feed the next, so it can't be a single atomic `batch()`. On D1 these inserts run sequentially and are **not** atomic — a mid-chain failure can leave partial rows. See the [Workers guide](../deployment/workers.md#d1-and-transactions).
:::

```typescript
useResource(postsTable, {
  db,
  id: postsTable.id,
  nestedWrites: true,
  relations: {
    author: {
      resource: "users", schema: usersTable, type: "belongsTo",
      foreignKey: postsTable.authorId, references: usersTable.id,
    },
    comments: {
      resource: "comments", schema: commentsTable, type: "hasMany",
      foreignKey: commentsTable.postId, references: postsTable.id,
    },
  },
});
```

```jsonc
// POST /api/posts
{
  "title": "Hello",
  // belongsTo parent — created first, its key wired into the post's foreignKey
  "author": { "id": "u1", "name": "Ada" },
  // hasMany children — created after the post, wired to the new post's referenced key
  "comments": [{ "text": "first!" }, { "text": "nice" }]
}
```

## Order of operations

Inside the transaction:

1. **`belongsTo` parents** are inserted first; the new parent's referenced value is written into the main row's foreign-key column.
2. **The main row** is inserted (after `onBeforeCreate` hooks run).
3. **`hasMany`/`hasOne` children** are inserted, each wired to the new row's referenced key. A `hasOne` value may be a single object; `hasMany` accepts an array (a single object is also accepted as one child).

The response is the **created main row** — parents and children are not echoed back. Refetch with [`?include=`](./relations.md) to read them.

## Limitation

`manyToMany` nested writes are **not** supported. Embedding a `manyToMany` relation in the create body has no effect on the junction table — manage those links separately (e.g. with a custom [RPC procedure](./procedures.md) or batch insert into the junction resource).

## Related

- [Relations](./relations.md) · [CRUD endpoints](./crud.md) · [Procedures & hooks](./procedures.md)
