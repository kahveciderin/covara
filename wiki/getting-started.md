# Getting Started with Concave

Concave is a real-time API framework built on Hono that provides automatic CRUD endpoints, subscriptions, authentication, and more. It runs standalone on Node.js and on Cloudflare Workers.

## Quick Start with the CLI

The fastest way to start is the scaffolding CLI:

```bash
npx concave create my-app                          # Node + SQLite (default)
npx concave create my-app --template cloudflare    # Cloudflare Workers + D1
npx concave create my-app --db postgres            # PostgreSQL
```

Options:

| Flag | Values | Default |
|------|--------|---------|
| `--template` | `node`, `cloudflare` | `node` |
| `--db` | `sqlite`, `postgres` | `sqlite` |
| `--no-install` | skip dependency install | — |

This scaffolds a complete project with a schema, database setup, drizzle-kit config, and a running server.

## Manual Setup

### Installation

```bash
npm install @kahveciderin/concave drizzle-orm @libsql/client zod
```

### 1. Define Your Schema

```typescript
// src/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").default("user"),
  createdAt: integer("createdAt", { mode: "timestamp" }),
});
```

### 2. Set Up Database

```typescript
// src/db.ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./data.db" });
export const db = drizzle(client);
```

### 3. Create Your API

```typescript
// src/main.ts
import { createConcave } from "@kahveciderin/concave";
import { startServer } from "@kahveciderin/concave/node";
import { usersTable } from "./schema.js";
import { db } from "./db.js";

const app = createConcave({ cors: true }).resource(usersTable, {
  id: usersTable.id,
  db,
  auth: { public: true },
});

const server = await startServer(app, { port: 3000 });
console.log(`Server running on http://localhost:${server.port}`);
```

That's it! You now have a full REST API with:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List users (paginated, filtered) |
| `GET` | `/api/users/:id` | Get single user |
| `POST` | `/api/users` | Create user |
| `PATCH` | `/api/users/:id` | Update user (partial) |
| `PUT` | `/api/users/:id` | Replace user |
| `DELETE` | `/api/users/:id` | Delete user |
| `GET` | `/api/users/count` | Count users |
| `GET` | `/api/users/aggregate` | Aggregation queries |
| `GET` | `/api/users/subscribe` | SSE real-time subscription |
| `POST` | `/api/users/batch` | Batch create |
| `PATCH` | `/api/users/batch` | Batch update |
| `DELETE` | `/api/users/batch` | Batch delete |
| `POST` | `/api/users/rpc/:name` | RPC procedures |

Health endpoints (`/healthz`, `/readyz`) and the OpenAPI spec (under `/__concave`) are mounted by default.

## The `createConcave` Factory

`createConcave(options)` returns a `ConcaveApp` (which extends Hono) with sensible defaults: RFC 7807 error handling, health endpoints, and OpenAPI generation.

```typescript
import { createConcave } from "@kahveciderin/concave";

const app = createConcave({
  basePath: "/api",          // resource mount prefix (default: "/api")
  cors: true,                // or a hono/cors config object
  auth: { router, middleware },  // result of useAuth()
  middleware: [],            // extra Hono MiddlewareHandlers applied to all routes
  observability: true,       // request metrics
  health: true,              // /healthz + /readyz (default: enabled)
  adminUI: true,             // admin dashboard at /__concave (default: disabled)
  openapi: true,             // OpenAPI spec at /__concave (default: enabled)
})
  .resource(usersTable, { id: usersTable.id, db })       // mounts at /api/users
  .resource("/people", usersTable, { id: usersTable.id, db });  // custom path
```

### Using Plain Hono

`useResource` returns a regular `Hono` router, so you can also compose everything yourself:

```typescript
import { Hono } from "hono";
import { useResource, errorHandler, notFoundHandler } from "@kahveciderin/concave";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);

app.route("/api/users", useResource(usersTable, { id: usersTable.id, db }));
```

## Resource Configuration Options

```typescript
useResource(usersTable, {
  id: usersTable.id,
  db,

  // Batch operation limits
  batch: {
    create: 50,
    update: 50,
    delete: 10,
  },

  // Pagination settings
  pagination: {
    defaultLimit: 20,
    maxLimit: 100,
  },

  // Rate limiting
  rateLimit: {
    windowMs: 60000,
    maxRequests: 100,
  },

  // Authentication scopes
  auth: {
    public: { read: true },
    update: async (user) => rsql`userId=="${user.id}"`,
  },

  // Optimistic concurrency (ETag / If-Match)
  etag: { versionField: "version" },

  // Custom filter operators
  customOperators: { ... },

  // Lifecycle hooks
  hooks: { ... },

  // RPC procedures
  procedures: { ... },
});
```

## Deploying

### Node.js

```typescript
import { startServer } from "@kahveciderin/concave/node";

const server = await startServer(app, {
  port: 3000,
  hostname: "0.0.0.0",
  onListen: ({ port }) => console.log(`Listening on ${port}`),
});

// later: await server.close();
```

### Cloudflare Workers

A `ConcaveApp` is a Hono app, so it is directly usable as a Worker:

```typescript
// src/worker.ts
import { drizzle } from "drizzle-orm/d1";
import { createConcave, type ConcaveApp } from "@kahveciderin/concave";
import { todos } from "./schema";

interface Env {
  DB: D1Database;
}

let app: ConcaveApp | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= createConcave({ cors: true }).resource(todos, {
      db: drizzle(env.DB),
      id: todos.id,
      auth: { public: true },
    });
    return app.fetch(request, env, ctx);
  },
};
```

```toml
# wrangler.toml
name = "my-app"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "my-app-db"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

See [Deployment](./deployment.md) for the full database matrix (libsql, better-sqlite3, D1, postgres-js, Neon, PGlite) and Workers cost notes.

## Client Setup

Connect from React with real-time subscriptions and offline support:

```typescript
// client.ts
import { getOrCreateClient } from "@kahveciderin/concave/client";

export const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,  // Enable offline support with LocalStorage
});

// App.tsx
import { useAuth, useLiveList } from "@kahveciderin/concave/client/react";

function App() {
  const { user, isAuthenticated, logout } = useAuth<User>();

  if (!isAuthenticated) return <LoginPage />;
  return <UserList />;
}

function UserList() {
  const { items, status, mutate } = useLiveList<User>("/api/users", {
    orderBy: "name:asc",
  });

  return (
    <ul>
      {items.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

## Next Steps

### Core Concepts
- [Resources](./resources.md) - Full resource configuration
- [Filtering](./filtering.md) - Query filter syntax
- [Pagination](./pagination.md) - Cursor-based pagination
- [Aggregations](./aggregations.md) - Statistical queries

### Real-time
- [Subscriptions](./subscriptions.md) - Real-time subscriptions

### Security
- [Authentication](./authentication.md) - Auth setup and scopes
- [Secure Queries](./secure-queries.md) - Scope-enforced query builder

### Client
- [Client Library](./client-library.md) - TypeScript client with React hooks
- [Offline Support](./offline-support.md) - Offline-first apps

### Advanced
- [Procedures & Hooks](./procedures.md) - RPC and lifecycle hooks
- [Mutation Tracking](./track-mutations.md) - Automatic changelog and cache invalidation
- [Error Handling](./error-handling.md) - Error types and handling
- [Deployment](./deployment.md) - Node, Cloudflare Workers, databases
- [Migrating from Express](./migrating-from-express.md) - Upgrade guide from Express-era Concave

### API Documentation
- [OpenAPI](./openapi.md) - OpenAPI spec generation
- [Middleware](./middleware.md) - Observability, versioning, rate limiting

### Development Tools
- [Admin UI](./admin-ui.md) - Built-in admin dashboard at /__concave/ui
