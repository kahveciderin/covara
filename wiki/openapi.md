# OpenAPI Generation

Concave can automatically generate OpenAPI 3.0 specifications from your resource definitions.

## Basic Usage

With `createConcave`, the OpenAPI router is mounted at `/__concave` by default — resources are auto-discovered from the schema registry as you register them:

```typescript
const app = createConcave()
  .resource(postsTable, { id: postsTable.id, db })
  .resource(usersTable, { id: usersTable.id, db });

// GET /__concave/openapi.json   - OpenAPI 3.0 spec
// GET /__concave/openapi.yaml   - YAML variant
// GET /__concave/schema         - Concave schema (used by typegen)
```

For manual setup, `createConcaveRouter` returns a Hono router:

```typescript
import { createConcaveRouter } from "@kahveciderin/concave/openapi";

app.route("/__concave", createConcaveRouter({
  title: "My API",
  version: "1.0.0",
  description: "A Concave-powered API",
  servers: [{ url: "https://api.example.com" }],
}));
```

To generate a spec object programmatically:

```typescript
import { generateOpenAPISpec, type RegisteredResource } from "@kahveciderin/concave/openapi";

const resources: RegisteredResource[] = [
  { name: "posts", path: "/api/posts", schema: postsTable },
  { name: "users", path: "/api/users", schema: usersTable },
];

const spec = generateOpenAPISpec(resources, {
  title: "My API",
  version: "1.0.0",
});
```

## Generated Endpoints

For each resource, the following endpoints are documented:

| Endpoint | Description |
|----------|-------------|
| `GET /` | List items with pagination |
| `GET /:id` | Get single item |
| `POST /` | Create item |
| `PATCH /:id` | Partial update |
| `PUT /:id` | Full replace |
| `DELETE /:id` | Delete item |
| `GET /count` | Count items |
| `GET /aggregate` | Aggregation queries |
| `GET /subscribe` | SSE subscription (`text/event-stream`) |
| `POST /batch` | Batch create |
| `PATCH /batch` | Batch update |
| `DELETE /batch` | Batch delete |
| `POST /rpc/{name}` | RPC procedures (one path per configured procedure) |

### Filter Operators

The `filter` query parameter's description enumerates the supported RSQL operators, and any
`customOperators` you configure on the resource are appended so consumers can discover them
from the spec alone.

### Enums

Columns backed by an enum (e.g. `text(...).enum([...])` or a pg enum) emit an `enum` list in
their property schema rather than a bare `string`.

### Subscriptions

`GET /subscribe` is documented with a `text/event-stream` response. The event payload schema
lists the event `type` values (`existing`, `added`, `changed`, `removed`, `invalidate`), and
the `filter`/`include` query parameters are described.

### ETag / Optimistic Concurrency

When a resource has `etag` configured, the spec reflects it:

- `GET /:id`, `POST /`, `PATCH /:id`, `PUT /:id` responses carry an `ETag` response header.
- `If-Match` and `If-None-Match` request-header parameters are documented.
- `GET /:id` documents a `304 Not Modified` response (If-None-Match match).
- `PATCH`/`PUT`/`DELETE` document a `412 Precondition Failed` response (If-Match mismatch).

## Schema Generation

Schemas are automatically derived from Drizzle table definitions:

```typescript
// Drizzle schema
const postsTable = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  published: integer("published", { mode: "boolean" }),
  createdAt: text("createdAt"),
});

// Generated OpenAPI schema
{
  "Post": {
    "type": "object",
    "required": ["id", "title"],
    "properties": {
      "id": { "type": "integer" },
      "title": { "type": "string" },
      "content": { "type": "string", "nullable": true },
      "published": { "type": "boolean" },
      "createdAt": { "type": "string" }
    }
  }
}
```

## Query Parameter Documentation

All standard query parameters are documented:

```yaml
parameters:
  - name: filter
    in: query
    schema:
      type: string
    description: Filter expression (e.g., status=="active")
  - name: select
    in: query
    schema:
      type: string
    description: Comma-separated field names to include
  - name: orderBy
    in: query
    schema:
      type: string
    description: Sort order (e.g., name:asc,createdAt:desc)
  - name: cursor
    in: query
    schema:
      type: string
    description: Pagination cursor
  - name: limit
    in: query
    schema:
      type: integer
    description: Maximum items to return
```

## Response Documentation

Standard response schemas are included:

- **List Response**: `{ items: [...], nextCursor, hasMore, totalCount }`
- **Count Response**: `{ count: number }`
- **Aggregate Response**: `{ groups: [...] }`
- **Error Response**: RFC 7807 Problem Details format

## Security Schemes

If authentication is configured, security schemes are generated:

```typescript
generateOpenAPISpec(resources, {
  // ...
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    },
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    },
  },
});
```

## Swagger UI Integration

Serve Swagger UI alongside your API by pointing it at the generated spec:

```typescript
import { swaggerUI } from "@hono/swagger-ui";

app.get("/docs", swaggerUI({ url: "/__concave/openapi.json" }));
```

## Related

- [Resources](./resources.md) - Resource configuration
- [Filtering](./filtering.md) - Filter syntax
- [Pagination](./pagination.md) - Pagination details
