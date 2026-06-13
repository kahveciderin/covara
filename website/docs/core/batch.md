---
id: batch
title: Batch operations
sidebar_label: Batch operations
description: Bulk create, update, delete, and upsert with configurable limits, filter-scoped batch mutations, and lifecycle hooks per item.
---

# Batch operations

Resources expose bulk endpoints for creating, updating, deleting, and upserting many rows at once. They are gated by the single [`enableBatch`](./resources-and-app.md#capabilities) capability and bounded by the `batch` limits.

## Limits

```typescript
useResource(postsTable, {
  id: postsTable.id,
  db,
  batch: {
    create: 50,  // max items per POST /batch
    update: 50,  // max items per PATCH /batch
    replace: 50, // max items per PUT-style replace batch
    delete: 10,  // max items per DELETE /batch
  },
});
```

Exceeding a limit returns a `BatchLimitError` (`400`). See [Error handling](../tooling/error-handling.md).

## Batch create — `POST /batch`

```bash
POST /api/posts/batch
Content-Type: application/json

{ "items": [{ "title": "A" }, { "title": "B" }] }
```

Each item runs the create [lifecycle hooks](./procedures.md) and emits an `added` [event](../realtime/subscriptions.md). [`fields.writable`](./fields.md) enforcement and `strictInput` apply per item. Returns `{ "items": [...] }` with the created rows (read-masked, computed fields applied).

## Batch update — `PATCH /batch`

Updates many rows matched by a filter, applying the same patch to each:

```bash
PATCH /api/posts/batch
Content-Type: application/json

{ "filter": "authorId==\"u1\";published==false", "patch": { "published": true } }
```

Each affected row runs the update hooks and emits a `changed` event. The matched set respects the [update scope](../auth/scopes.md).

## Batch delete — `DELETE /batch`

```bash
DELETE /api/posts/batch
Content-Type: application/json

{ "filter": "status==\"spam\"" }
```

Deletes (or [soft-deletes](./soft-delete.md)) the matching rows within the delete scope, running delete hooks and emitting `removed` events.

## Bulk upsert — `POST /batch/upsert` {#bulk-upsert}

Inserts or updates a list keyed by primary key, in a single transaction. Same request shape as batch create, bounded by `batch.create`. Requires **both** `create` and `update` scope plus `enableBatch`.

```bash
POST /api/posts/batch/upsert
Content-Type: application/json

{
  "items": [
    { "id": "p1", "title": "Existing, updated" },
    { "id": "p2", "title": "Brand new" }
  ]
}
```

For each item:

- **Exists** → runs `onBeforeUpdate`/`onAfterUpdate`, emits `changed`.
- **New** → runs `onBeforeCreate`/`onAfterCreate`, emits `added`.

`fields.writable` enforcement applies to every item. Returns `{ "items": [...] }` with the upserted rows.

## Notes

- Batch mutations participate in [mutation tracking](../realtime/mutation-tracking.md), so every item streams to subscribers and invalidates caches.
- Confirmation/safety bounds and the per-operation limits guard against runaway bulk writes.

## Related

- [CRUD endpoints](./crud.md) · [Procedures & hooks](./procedures.md) · [Soft delete](./soft-delete.md)
- [Authorization scopes](../auth/scopes.md) · [Error handling](../tooling/error-handling.md)
