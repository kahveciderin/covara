# Pagination

Covara uses cursor-based pagination for efficient traversal of large datasets. This approach provides consistent results even when data is being modified.

## Basic Usage

### Server-side

Pagination is automatically enabled on all list endpoints. Configure default and maximum limits:

```typescript
app.route("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
  pagination: {
    defaultLimit: 20,  // Default page size
    maxLimit: 100,     // Maximum allowed page size
  },
}));
```

### Client-side

```typescript
const users = client.resource<User>("/users");

// First page
const page1 = await users.list({ limit: 10 });
console.log(page1.items);      // Array of users
console.log(page1.hasMore);    // true if more pages exist
console.log(page1.nextCursor); // Cursor for next page

// Next page
if (page1.hasMore) {
  const page2 = await users.list({ limit: 10, cursor: page1.nextCursor });
}
```

## Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Number of items per page (capped by `maxLimit`) |
| `cursor` | string | Opaque cursor from previous response |
| `orderBy` | string | Sort order, e.g. `name:asc,createdAt:desc` or the `-field` shorthand `-createdAt` |
| `totalCount` | boolean | Include total count in response |

## Response Format

```typescript
interface PaginatedResponse<T> {
  items: T[];           // Array of items for current page
  nextCursor: string | null;  // Cursor for next page, null if last page
  hasMore: boolean;     // Whether more pages exist
  totalCount?: number;  // Total count (if requested)
}
```

## Ordering

Control sort order with the `orderBy` parameter:

```typescript
// Single field ascending
await users.list({ orderBy: "name:asc" });

// Single field descending
await users.list({ orderBy: "createdAt:desc" });

// Multiple fields
await users.list({ orderBy: "role:asc,name:asc" });

// The "-field" (JSON:API) convention is also supported for descending,
// and may be mixed with the "field:dir" form across fields:
await users.list({ orderBy: "-createdAt" });          // same as "createdAt:desc"
await users.list({ orderBy: "-createdAt,name" });     // desc, then asc
```

> Combining both syntaxes on the **same** field (e.g. `-name:desc`) is a conflict
> and returns a `400` — pick one form per field.

**Note:** Cursor-based pagination requires consistent ordering. The primary key is always included as the final sort criterion for stable pagination.

## Total Count

Request total count with the `totalCount` parameter:

```typescript
const result = await users.list({
  limit: 10,
  totalCount: true
});

console.log(result.totalCount); // e.g., 1234
console.log(result.items.length); // 10
```

**Performance Note:** Total count requires an additional COUNT query. For large tables, consider omitting it when not needed.

## Combining with Filters

Pagination works seamlessly with filtering:

```typescript
// Paginate through active admin users
const admins = await users.list({
  filter: 'role=="admin";active==true',
  orderBy: "name:asc",
  limit: 20,
});

// Get next page with same filter
const nextPage = await users.list({
  filter: 'role=="admin";active==true',
  orderBy: "name:asc",
  limit: 20,
  cursor: admins.nextCursor,
});
```

## Iterating All Pages

```typescript
async function getAllUsers(filter?: string): Promise<User[]> {
  const users = client.resource<User>("/users");
  const allItems: User[] = [];
  let cursor: string | null = null;

  do {
    const page = await users.list({
      filter,
      limit: 100,
      cursor: cursor ?? undefined,
    });

    allItems.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return allItems;
}
```

## Cursor Internals

Cursors are base64-encoded JSON containing:
- The last item's sort values
- The last item's ID

This ensures stable pagination even with concurrent modifications. Example decoded cursor:

```json
{
  "values": { "name": "Alice", "id": 42 },
  "orderBy": ["name:asc", "id:asc"]
}
```

**Security:** Cursors are tamper-evident. Modified cursors will result in validation errors.

## Best Practices

1. **Always use cursor-based pagination** for user-facing lists to ensure consistency
2. **Limit the `maxLimit`** to prevent clients from requesting too much data
3. **Use consistent ordering** when paginating to avoid missing or duplicate items
4. **Avoid `totalCount`** on large tables unless necessary
5. **Set reasonable `defaultLimit`** to balance UX and performance

## HTTP Examples

```bash
# First page of 10 items
curl "http://localhost:3000/api/users?limit=10"

# Next page using cursor
curl "http://localhost:3000/api/users?limit=10&cursor=eyJpZCI6MTB9"

# With ordering and total count
curl "http://localhost:3000/api/users?limit=20&orderBy=name:asc&totalCount=true"

# Combined with filter
curl "http://localhost:3000/api/users?filter=active==true&limit=10&orderBy=createdAt:desc"
```
