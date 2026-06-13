---
id: openapi
title: OpenAPI
sidebar_label: OpenAPI
description: Auto-generated OpenAPI 3.0 specs from your resources — endpoints, schemas from Drizzle columns, filter operators, ETag headers, security schemes, and Swagger UI.
---

# OpenAPI

Covara generates an OpenAPI 3.0 spec from your resource definitions. With `createCovara`, the router is mounted at `/__covara` by default and resources are auto-discovered as you register them.

```typescript
const app = createCovara()
  .resource(postsTable, { id: postsTable.id, db })
  .resource(usersTable, { id: usersTable.id, db });

// GET /__covara/openapi.json   OpenAPI 3.0 spec
// GET /__covara/openapi.yaml   YAML variant
// GET /__covara/schema         Covara schema (used by typegen)
```

## Manual setup

```typescript
import { createCovaraRouter } from "covara/openapi";

app.route("/__covara", createCovaraRouter({
  title: "My API",
  version: "1.0.0",
  description: "A Covara-powered API",
  servers: [{ url: "https://api.example.com" }],
}));
```

Generate a spec object programmatically:

```typescript
import { generateOpenAPISpec, type RegisteredResource } from "covara/openapi";

const resources: RegisteredResource[] = [
  { name: "posts", path: "/api/posts", schema: postsTable },
  { name: "users", path: "/api/users", schema: usersTable },
];
const spec = generateOpenAPISpec(resources, { title: "My API", version: "1.0.0" });
```

## What's documented

For each resource: list/get/create/update/replace/delete, count, aggregate, subscribe, the batch routes, and one path per configured [RPC procedure](../core/procedures.md).

- **Schemas** are derived from Drizzle columns (types, `required`, `nullable`); enum-backed columns emit an `enum` list.
- **Filter operators** — the `filter` parameter description enumerates the supported [RSQL operators](../core/filtering.md), with your `customOperators` appended so consumers can discover them.
- **Subscriptions** — `GET /subscribe` is documented with a `text/event-stream` response and the event `type` values (`existing`, `added`, `changed`, `removed`, `invalidate`), plus `filter`/`include` params.
- **ETag** — when [`etag`](../core/optimistic-locking.md) is configured, responses document the `ETag` header, `If-Match`/`If-None-Match` params, the `304` (GET), and the `412` (PATCH/PUT/DELETE).
- **Responses** — standard list/count/aggregate shapes and the RFC 7807 [error format](./error-handling.md).
- **Security schemes** — generated when auth is configured.

```typescript
generateOpenAPISpec(resources, {
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
  },
});
```

## Swagger UI

```typescript
import { swaggerUI } from "@hono/swagger-ui";
app.get("/docs", swaggerUI({ url: "/__covara/openapi.json" }));
```

The `/__covara/schema` endpoint is what [type generation](../client/typegen.md) consumes.

## Related

- [Type generation](../client/typegen.md) · [Admin UI](./admin-ui.md) · [Resources](../core/resources-and-app.md)
