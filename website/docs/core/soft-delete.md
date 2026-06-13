---
id: soft-delete
title: Soft delete
sidebar_label: Soft delete
description: Mark rows deleted instead of removing them — reads hide soft-deleted rows by default, subscribers see a removed event, and ?withDeleted=true reveals them.
---

# Soft delete

Soft delete marks rows as deleted by setting a column, instead of removing them from the table. Reads hide soft-deleted rows by default; pass `?withDeleted=true` to include them.

## Configuration

```typescript
useResource(postsTable, {
  id: postsTable.id,
  db,
  softDelete: {
    field: postsTable.deletedAt,   // column used as the deletion marker
    // deletedValue: () => Date.now(), // optional; defaults to current ISO timestamp
  },
});
```

A row is considered deleted when the `field` column is **non-null**. Pass the **Drizzle column** (like `id`); a string column name also works but is deprecated.

## Behavior

- `DELETE /:id` **sets the marker column** instead of removing the row, and still returns `204`.
- Subscribers receive a **`removed`** event, because the row leaves the (not-deleted) read scope.
- `GET /`, `GET /:id`, `GET /count`, `GET /aggregate`, and subscription snapshots **exclude** soft-deleted rows.
- Pass `?withDeleted=true` to include soft-deleted rows in any of those reads.
- Re-deleting an already soft-deleted row returns `404` — it is invisible to the delete scope.

```bash
DELETE /api/posts/p1                 # sets deletedAt, returns 204
GET    /api/posts                    # p1 is hidden
GET    /api/posts?withDeleted=true   # p1 is included
```

## Custom marker values

Use `deletedValue` for non-timestamp columns. The column counts as "deleted" whenever it is non-null.

```typescript
softDelete: { field: postsTable.isDeleted, deletedValue: () => 1 }   // integer flag
softDelete: { field: postsTable.deletedAt, deletedValue: () => Date.now() } // numeric epoch
```

## Restoring

There is no dedicated restore endpoint — clear the marker with an update (the row must be reachable via `?withDeleted=true` and your update scope):

```bash
PATCH /api/posts/p1
{ "deletedAt": null }
```

## Related

- [CRUD endpoints](./crud.md) · [Subscriptions](../realtime/subscriptions.md) — soft delete emits `removed`
- [Resources](./resources-and-app.md#softdelete)
