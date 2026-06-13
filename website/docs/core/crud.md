---
id: crud
title: CRUD endpoints
sidebar_label: CRUD endpoints
description: The read and write endpoints every resource generates — list, get, create, update, replace, delete, count — with request/response shapes and projections.
---

# CRUD endpoints

Every [resource](./resources-and-app.md) generates a standard set of REST endpoints. This page documents their request and response shapes. Filtering, pagination, ordering, and relation includes are covered in their own pages and apply to the list endpoint.

## List — `GET /`

Returns a paginated list. Supports [`filter`](./filtering.md), [`select`](#projections), [`include`](./relations.md), [`orderBy`, `cursor`, `limit`, `totalCount`](./pagination.md).

```bash
GET /api/posts?filter=published==true&orderBy=createdAt:desc&limit=20&include=author
```

```json
{
  "items": [{ "id": "p1", "title": "Hello", "author": { "id": "u1", "name": "Ada" } }],
  "nextCursor": "eyJ2YWx1ZXMiOnsuLi59fQ==",
  "hasMore": true,
  "totalCount": 137
}
```

`totalCount` is present only when `?totalCount=true`.

## Get one — `GET /:id`

```bash
GET /api/posts/p1?include=author,tags
```

Returns the single row, or `404` if not found or outside the read [scope](../auth/scopes.md). With [ETags](./optimistic-locking.md) enabled, the response carries an `ETag` header and honors `If-None-Match` (returns `304`).

## Create — `POST /`

```bash
POST /api/posts
Content-Type: application/json

{ "title": "Hello", "body": "..." }
```

- Runs `onBeforeCreate` → insert → `onAfterCreate` ([hooks](./procedures.md)).
- [`fields.writable`](./fields.md) strips non-writable columns before hooks run; [`strictInput`](./fields.md) rejects unknown fields with `422`.
- Emits an `added` [subscription event](../realtime/subscriptions.md).
- Returns the created row (`201`), read-masked with [computed fields](./fields.md#computed-fields) applied.
- With [`nestedWrites`](./nested-writes.md), embedded relation objects are created in the same transaction.

## Update (partial) — `PATCH /:id`

Updates only the provided fields.

```bash
PATCH /api/posts/p1
Content-Type: application/json

{ "title": "Updated title" }
```

Runs `onBeforeUpdate` → update → `onAfterUpdate`, emits a `changed` event, enforces [`If-Match`](./optimistic-locking.md) when ETags are configured (`412` on mismatch), and auto-increments the version field.

## Replace (full) — `PUT /:id`

Same as `PATCH` but replaces the whole row; omitted writable fields are reset to their defaults/null. Governed by the same `enableUpdate` [capability](./resources-and-app.md#capabilities).

## Delete — `DELETE /:id`

```bash
DELETE /api/posts/p1
```

Returns `204`. Runs `onBeforeDelete`/`onAfterDelete`, emits a `removed` event, enforces `If-Match`. With [`softDelete`](./soft-delete.md), the row is marked instead of removed.

## Counting — `GET /count` {#counting}

```bash
GET /api/posts/count?filter=published==true
```

```json
{ "count": 137 }
```

Honors the read scope and `filter`; excludes [soft-deleted](./soft-delete.md) rows unless `?withDeleted=true`.

## Projections

The `select` parameter narrows returned columns:

```bash
GET /api/posts?select=id,title,createdAt
GET /api/posts/p1?select=id,title
```

`select` cannot recover columns hidden by [`fields.readable`](./fields.md) — masking is applied after projection. [Computed fields](./fields.md#computed-fields) and included relations always pass through.

The typed client narrows the return type to exactly the selected fields — see [Client queries](../client/queries.md).

## Error format

All errors use RFC 7807 Problem Details. See [Error handling](../tooling/error-handling.md).

```json
{
  "type": "https://covara.dev/errors/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "post p1 not found"
}
```

## Related

- [Filtering](./filtering.md) · [Pagination](./pagination.md) · [Relations](./relations.md)
- [Fields](./fields.md) · [Optimistic locking](./optimistic-locking.md) · [Batch operations](./batch.md)
- [Subscriptions](../realtime/subscriptions.md) — every mutation streams to subscribers
