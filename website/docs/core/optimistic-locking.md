---
id: optimistic-locking
title: Optimistic locking (ETags)
sidebar_label: Optimistic locking
description: ETag emission, If-Match compare-and-swap on writes, If-None-Match 304 reads, and auto-incrementing version fields for lost-update protection.
---

# Optimistic locking (ETags)

Configure `etag` on a resource to get HTTP conditional requests and optimistic concurrency control: ETag headers on single-item responses, `If-Match` enforcement on writes (with compare-and-swap), `If-None-Match` 304s on reads, and auto-incrementing version fields.

```typescript
useResource(postsTable, {
  id: postsTable.id,
  db,
  etag: {
    versionField: postsTable.version,      // integer column, auto-incremented on every update
    // updatedAtField: postsTable.updatedAt,  // alternative: timestamp-based tags
    // idField: postsTable.id,                // paired with updatedAtField (default "id")
    // algorithm: "weak",                      // "weak" (default) or "strong"
  },
});
```

Pass the **Drizzle column** to `versionField`/`updatedAtField`/`idField` (like `id`); a string column name also works but is deprecated.

Without the `etag` config, no ETag headers are emitted and conditional headers are ignored.

## ETag emission

`POST /`, `GET /:id`, `PATCH /:id`, and `PUT /:id` responses carry an `ETag` header. The tag is derived in this precedence:

1. `versionField` (if set and present on the item), then
2. `updatedAtField` + `idField` (timestamp-id pair), then
3. an MD5 hash of the serialized item.

Tags are **weak** (`W/"..."`) unless `algorithm: "strong"`. The same item state always produces the same ETag. Treat ETags as **opaque** — the hash-fallback format may change between minor versions.

## Conditional writes — `If-Match`

`If-Match` is checked against the **current** stored item on `PATCH /:id`, `PUT /:id`, and `DELETE /:id` before the mutation runs:

- **Mismatch → `412 Precondition Failed`** (RFC 7807 body with `currentETag` in `details`); the row is unchanged.
- **Compare-and-swap:** when `If-Match` is present, the write statement carries a CAS predicate on the version/updated-at field, so the validated version must still match at write time. If a concurrent writer changed the row between read and write, zero rows match and the request fails with `412` — exactly one of N concurrent `If-Match` writers wins, the rest get `412`.
- **`If-Match: *`** matches any current state (write proceeds if the item exists).
- A comma-separated list passes if **any** tag matches; comparison uses RFC 7232 strong comparison.
- **No header → unconditional** write (last-write-wins, no CAS predicate).

```bash
PATCH /api/posts/p1
If-Match: W/"4"
Content-Type: application/json

{ "title": "New title" }
# → 200 with ETag W/"5", or 412 if the stored version is no longer 4
```

## Conditional reads — `If-None-Match`

`GET /:id` with a matching `If-None-Match` returns `304 Not Modified` (empty body, current `ETag`). A non-matching tag returns `200` with the full representation.

```bash
GET /api/posts/p1
If-None-Match: W/"5"
# → 304 if unchanged, 200 + body otherwise
```

## Version auto-increment

When `versionField` is configured, it is incremented by 1 on every `PATCH`/`PUT`, starting from the stored value (missing/non-numeric values are left untouched). If the request body explicitly sets the version field, that value is used instead.

**Lost-update protection:** two clients read version N and both write with `If-Match`. The CAS predicate guarantees exactly one write lands; the other matches zero rows, gets `412`, and must refetch.

## Limitations

- `GET /` (list) responses do **not** carry per-item ETags.
- `If-Match` is **not** enforced on `/batch` operations, and batch updates do not auto-increment the version field.
- The CAS predicate requires a `versionField` or `updatedAtField`. With neither (hash-only ETags), `If-Match` is still checked before the write but is not atomic with it.

See the [ETag contract](../contracts/etag.md) for the full guarantee list and failure modes.

## Client integration

The [offline client](../client/offline.md) tracks ETags per item and replays `If-Match` on queued mutations, surfacing `412`s as conflicts to reconcile.

## Related

- [CRUD endpoints](./crud.md) · [Offline support](../client/offline.md) · [ETag contract](../contracts/etag.md)
