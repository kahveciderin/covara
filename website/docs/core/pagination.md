---
id: pagination
title: Pagination
sidebar_label: Pagination
description: Cursor-based keyset pagination with multi-field ordering, stable ordering, opaque tamper-evident cursors, and optional total counts.
---

# Pagination

Covara uses **cursor-based (keyset) pagination** for list endpoints. It is stable under concurrent modification — inserting or deleting rows on an earlier page does not shift items across page boundaries the way offset pagination does.

## Configuration

```typescript
useResource(usersTable, {
  id: usersTable.id,
  db,
  pagination: {
    defaultLimit: 20, // page size when ?limit is omitted
    maxLimit: 100,    // ceiling; larger ?limit values are clamped
  },
});
```

## Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Items per page (capped by `maxLimit`). |
| `cursor` | string | Opaque cursor from the previous response. |
| `orderBy` | string | Sort order, e.g. `name:asc,createdAt:desc`, or the `-field` shorthand. |
| `totalCount` | boolean | Include the total count of matching rows. |

## Response shape

```typescript
interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null; // null on the last page
  hasMore: boolean;
  totalCount?: number;       // only when totalCount=true
}
```

## Ordering

```bash
GET /api/users?orderBy=name:asc
GET /api/users?orderBy=createdAt:desc
GET /api/users?orderBy=role:asc,name:asc      # multi-field
GET /api/users?orderBy=-createdAt             # JSON:API shorthand = createdAt:desc
GET /api/users?orderBy=-createdAt,name        # desc, then asc
```

Mixing both syntaxes on the **same** field (e.g. `-name:desc`) is a conflict and returns `400`.

The primary key is always appended as the final sort key to guarantee a total ordering, so pagination never skips or duplicates rows even when the chosen sort columns have ties.

## Total count

```bash
GET /api/users?limit=10&totalCount=true
```

`totalCount` requires an extra `COUNT` query. Omit it on large tables when you do not need it.

## Cursor internals

A cursor is base64-encoded JSON capturing the last row's sort values and ID plus the order spec:

```json
{ "values": { "name": "Alice", "id": 42 }, "orderBy": ["name:asc", "id:asc"] }
```

Cursors are tamper-evident — a modified cursor fails validation with a `400`. See the [pagination contract](../contracts/pagination.md) for the cursor-integrity guarantees. **Do not** change `orderBy` between pages while reusing a cursor; the cursor encodes the order it was issued for.

## Client usage

```typescript
const users = client.resource<User>("/api/users");

const page1 = await users.list({ limit: 10, orderBy: "name:asc" });
if (page1.hasMore) {
  const page2 = await users.list({ limit: 10, orderBy: "name:asc", cursor: page1.nextCursor });
}
```

Iterate every page:

```typescript
async function getAll(filter?: string): Promise<User[]> {
  const out: User[] = [];
  let cursor: string | null = null;
  do {
    const page = await users.list({ filter, limit: 100, cursor: cursor ?? undefined });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}
```

In React, prefer [`useInfiniteList`](../client/react-hooks.md) / `useLiveList`'s `loadMore` which manage cursors for you.

## Best practices

- Keep `maxLimit` modest to bound payload size and query cost.
- Index the columns you sort by; the trailing primary-key tiebreaker should be indexed too.
- Avoid `totalCount` on large tables unless the UI needs it.
- Keep `orderBy` constant across a paged sequence.

## Related

- [Filtering](./filtering.md) — combine `filter` with pagination
- [Client queries](../client/queries.md) · [React hooks](../client/react-hooks.md)
- [Pagination contract](../contracts/pagination.md)
