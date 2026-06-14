---
id: quick-start
title: Quick Start
sidebar_label: Quick Start
description: Scaffold a Covara project with the CLI — add --frontend react for a full-stack real-time app — or drop it into an existing Hono app for a full REST + real-time API in minutes.
---

# Quick Start

There are two ways to get going: scaffold a fresh project with the CLI, or add Covara to an app you already have.

## Option 1 — Scaffold with the CLI

The fastest path is the `covara create` scaffolder:

```bash
npx covara create my-app                          # Node + SQLite (default)
npx covara create my-app --template cloudflare    # Cloudflare Workers + D1
npx covara create my-app --db postgres            # PostgreSQL
```

:::tip Want a full-stack app? Add `--frontend react`

```bash
npx covara create my-app --frontend react
```

This is the easiest way to get a complete real-time full-stack application. On top of the API it scaffolds a **React + Vite** SPA wired to the typed client with [`useLiveList`](./client/react-hooks.md) — so the UI updates in real time out of the box — and a **single-process dev server**: `npm run dev` serves the SPA (with HMR), the API (`/api`), and the admin UI (`/__covara`) on one origin, while live-regenerating the typed client. No proxy, no second terminal.

:::

| Flag | Values | Default |
|------|--------|---------|
| `--frontend` | `react`, `none` | `none` |
| `--template` | `node`, `cloudflare` | `node` |
| `--db` | `sqlite`, `postgres` | `sqlite` |
| `--no-install` | skip dependency install | — |

This generates a complete project: a Drizzle schema, database setup, a `drizzle.config.ts`, a running server, the right `package.json` scripts, and — with `--frontend react` — a ready-to-edit React frontend. See the [CLI reference](./tooling/cli.md) for everything it produces.

```bash
cd my-app
npm run dev       # start the server — covara dev creates/updates tables automatically
```

`npm run dev` runs [`covara dev`](./tooling/cli.md#covara-dev), which auto-applies additive schema changes on start (creating your tables on first run), so there's no separate `npm run db:push`. Use `db:push` only for destructive changes or in CI.

## Option 2 — Add to an existing app

### Install

```bash
npm install covara drizzle-orm @libsql/client zod
```

`drizzle-orm`, `zod`, and (for the client hooks) `react` are peer dependencies — install the versions your project uses.

### 1. Define your schema

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

### 2. Set up the database

```typescript
// src/db.ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./data.db" });
export const db = drizzle(client);
```

### 3. Create the API

```typescript
// src/main.ts
import { createCovara } from "covara";
import { startServer } from "covara/node";
import { usersTable } from "./schema.js";
import { db } from "./db.js";

const app = createCovara({ cors: true }).resource(usersTable, {
  id: usersTable.id,
  db,
  auth: { public: true },
});

const server = await startServer(app, { port: 3000 });
console.log(`Server running on http://localhost:${server.port}`);
```

That's it. You now have a full REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List users (paginated, filtered, ordered) |
| `GET` | `/api/users/:id` | Get a single user |
| `POST` | `/api/users` | Create a user |
| `PATCH` | `/api/users/:id` | Update a user (partial) |
| `PUT` | `/api/users/:id` | Replace a user |
| `DELETE` | `/api/users/:id` | Delete a user |
| `GET` | `/api/users/count` | Count users (filtered) |
| `GET` | `/api/users/aggregate` | [Aggregation queries](./core/aggregations.md) |
| `GET` | `/api/users/aggregate/subscribe` | [Live aggregation (SSE)](./realtime/aggregate-subscriptions.md) |
| `GET` | `/api/users/subscribe` | [Real-time subscription (SSE)](./realtime/subscriptions.md) |
| `GET` | `/api/users/search` | [Full-text search](./core/search.md) (when configured) |
| `POST` | `/api/users/batch` | [Batch create](./core/batch.md) |
| `PATCH` | `/api/users/batch` | Batch update |
| `DELETE` | `/api/users/batch` | Batch delete |
| `POST` | `/api/users/rpc/:name` | [RPC procedures](./core/procedures.md) |

Health endpoints (`/healthz`, `/readyz`) and the OpenAPI spec (under `/__covara`) are mounted by default. See [Generated endpoints](./core/crud.md) for the full reference.

## The `createCovara` factory

`createCovara(options)` returns a `CovaraApp` (which extends `Hono`) with sensible defaults: RFC 7807 error handling, health endpoints, OpenAPI generation, and security headers.

```typescript
const app = createCovara({
  basePath: "/api",         // resource mount prefix (default: "/api")
  cors: true,               // or a hono/cors config object
  auth: { router, middleware }, // result of useAuth()
  middleware: [],           // extra Hono middleware applied to all routes
  observability: true,      // request/subscription metrics
  health: true,             // /healthz + /readyz (default: enabled)
  adminUI: true,            // admin dashboard at /__covara (default: disabled)
  openapi: true,            // OpenAPI spec at /__covara (default: enabled)
})
  .resource(usersTable, { id: usersTable.id, db })             // mounts at /api/users
  .resource("/people", usersTable, { id: usersTable.id, db }); // custom path
```

`.resource()` is chainable and infers the mount path from the table name unless you pass one explicitly. Full option reference: **[Resources & the app factory](./core/resources-and-app.md)**.

## Using a plain Hono app

`useResource` returns an ordinary `Hono` router, so you can compose everything yourself instead of using the factory:

```typescript
import { Hono } from "hono";
import { useResource, errorHandler, notFoundHandler } from "covara";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);

app.route("/api/users", useResource(usersTable, { id: usersTable.id, db }));
```

## Connect the client

```typescript
// client.ts
import { getOrCreateClient } from "covara/client";

export const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true, // optimistic updates + offline queue
});
```

```tsx
// App.tsx
import { useAuth, useLiveList } from "covara/client/react";

function App() {
  const { isAuthenticated } = useAuth<User>();
  if (!isAuthenticated) return <LoginPage />;
  return <UserList />;
}

function UserList() {
  const { items } = useLiveList<User>("/api/users", { orderBy: "name:asc" });
  return <ul>{items.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

The list updates in real time as anyone mutates `/api/users`. Continue with the **[Client library](./client/overview.md)**.

## Next steps

- **[Tutorial](./tutorial.md)** — build a complete real-time todo app, server and client.
- **[Resources](./core/resources-and-app.md)** — every configuration option in depth.
- **[Authentication](./auth/overview.md)** — add login, sessions, scopes.
- **[Deployment](./deployment/node.md)** — ship to Node or Cloudflare Workers.
