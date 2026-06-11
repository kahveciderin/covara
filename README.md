# Concave

**Your Drizzle schema is already a backend.** Concave turns it into a complete, production-ready API — REST endpoints, real-time subscriptions, auth, file uploads, billing, email, and background jobs — with a type-safe, offline-first TypeScript client on the other end. Built on [Hono](https://hono.dev), it runs standalone on Node or at the edge on Cloudflare Workers.

## The Goal

Every product backend is the same 80%: CRUD endpoints, filtering, pagination, auth, sessions, password reset, file uploads, webhooks for payments, transactional email, a job queue, and a client that talks to all of it. You rewrite this plumbing for every project, and the pieces never quite fit together — your realtime layer doesn't know about your auth scopes, your client types drift from your API, your offline cache fights your subscriptions.

Concave's goal is to make that 80% *one coherent system* derived from a single source of truth: your Drizzle schema.

- **Define a table** → get a full REST API with filtering, pagination, aggregations, batch ops, and OpenAPI docs.
- **Add an auth scope** → it's enforced everywhere: queries, mutations, subscriptions, search.
- **Mutate data anywhere** — generated endpoint, custom route, RPC — and every subscribed client updates in real time.
- **Use the client** → full TypeScript inference, optimistic updates, offline queue, automatic reconnect. In React, React Native, or plain TS.

The remaining 20% — your business logic — goes in lifecycle hooks, RPC procedures, and ordinary Hono routes, with the framework's tracking and typing intact.

```typescript
// server: a table becomes an API
const app = createConcave({ cors: true })
  .resource("/todos", todosTable, {
    id: todosTable.id,
    db,
    auth: { update: async (user) => rsql`userId=="${user.id}"` },
  });

// client: the API becomes live UI
function TodoList() {
  const { items, mutate } = useLiveList<Todo>("/api/todos", { orderBy: "position" });
  return items.map((todo) => (
    <Todo key={todo.id} {...todo} onDelete={() => mutate.delete(todo.id)} />
  ));
  // creates/updates/deletes apply optimistically, sync offline,
  // and stream to every other connected client over SSE
}
```

## Features

### Core API
- **Automatic REST API** - Full CRUD endpoints from your Drizzle schema
- **Real-time Subscriptions** - SSE with changelog-based updates, sequence numbers, and seamless reconnection
- **Relations & Joins** - `belongsTo`, `hasOne`, `hasMany`, `manyToMany` with efficient batch loading
- **RSQL Filtering** - Comprehensive query language (30+ operators) plus custom operators
- **Cursor Pagination** - Keyset pagination with multi-field ordering
- **Aggregations** - Group by, count, sum, avg, min, max, with `HAVING` filtering on aggregate output
- **Nested Write-Through** - Create `belongsTo` parents and `hasMany`/`hasOne` children in one atomic POST
- **Soft Delete** - Mark rows deleted instead of removing them; reads hide them unless `?withDeleted=true`
- **Batch Operations** - Bulk create, update, delete with limits, plus bulk upsert (`POST /batch/upsert`)
- **Writable Enforcement** - `fields.writable` is an enforced allowlist (mass-assignment protection); `strictInput` rejects unknown fields
- **Computed Fields** - Virtual `computed` fields added to every response and subscription event
- **Optimistic Locking** - ETags, If-Match preconditions with compare-and-swap, auto-incrementing version fields
- **Full-Text Search** - Built-in SQLite FTS5 / Postgres `tsvector` / OpenSearch / in-memory adapters, with an opt-in transactional outbox for at-least-once index convergence
- **RPC Procedures & Lifecycle Hooks** - Custom Zod-validated endpoints and before/after hooks on every operation
- **Mutation Tracking** - Wrap your Drizzle db so custom routes feed subscriptions and cache invalidation automatically

### Runs Everywhere
- **Standalone Node** - `startServer(app)` via `@kahveciderin/concave/node`
- **Cloudflare Workers** - `export default app`, D1/Postgres, `nodejs_compat`
- **Durable Object KV** - Cross-isolate subscriptions, rate limits, and sessions on Workers without Redis
- **SQLite & PostgreSQL** - libsql, better-sqlite3, D1, postgres-js, Neon, PGlite via Drizzle

### Authentication & Security
- **OIDC Provider** - Built-in OpenID Connect server with PKCE, token revocation (RFC 7009) and introspection (RFC 7662)
- **OIDC Hardening** - Component-wise redirect-URI validation, PKCE-required public clients (plain rejected), federated id_token verification, endpoint rate limiting, KV-backed stores by default
- **Dynamic Client Registration & Consent Revocation** - Opt-in `POST /register`, plus `POST /consent/revoke` and consent TTL
- **Federated Login** - Google, Microsoft, Okta, Auth0, Keycloak, custom
- **JWT Auth** - JWT bearer adapter on the server, `JWTClient` + `useJWTAuth` hook on the client with pluggable token storage (localStorage, memory, AsyncStorage)
- **Session Auth** - Auth.js, Passport.js, and session adapters with session rotation on login
- **Multi-Factor Auth** - Opt-in TOTP MFA with backup codes
- **Magic Links** - Opt-in passwordless email login
- **API Keys** - Standalone helpers to create, verify, rotate, and revoke hashed API keys
- **Password Hashing & Policy** - Built-in scrypt `hashPassword`/`verifyPassword`/`needsRehash` (Workers-safe) plus an enforceable password policy
- **Account Security** - Opt-in CSRF protection, login throttling, email verification, password reset
- **Security Headers** - CSP, HSTS, `X-Frame-Options`, and more, auto-mounted by `createConcave`
- **Authorization Scopes** - Row-level security with RSQL expressions, enforced across reads, writes, subscriptions, and search
- **Field-level Read Masking** - `fields.readable` allowlist strips non-readable columns from every response and subscription event (cannot be bypassed via `?select=`)

### File Storage
- **Storage Adapters** - Local disk, S3, Cloudflare R2 (native binding or S3-compat), and in-memory behind one `StorageAdapter` interface
- **File Resources** - `useFileResource` generates upload/download/list/delete endpoints with MIME and size validation, per-user key generation, and auth scopes
- **Presigned URLs** - Optional direct-to-bucket uploads/downloads with configurable expiry
- **React Hooks** - `useFileUpload` (with progress), `useFile`, `useFiles`; `getDownloadUrl()` for React Native

### Background Processing
- **Task Queue** - Distributed background jobs with Redis, Durable Objects, or in-memory backends
- **Cloudflare Queues** - Producer/consumer adapter for running tasks on Workers without a poller
- **Retry Strategies** - Exponential, linear, or fixed backoff
- **Scheduling** - Delayed execution, cron expressions, recurring tasks with a missed-occurrence `catchup` policy
- **Progress & Result TTL** - `ctx.reportProgress`, heartbeats, and `resultTtlMs` result expiry
- **Idempotency & Concurrency** - Per-task idempotency keys and enforced `maxConcurrency`
- **Graceful Drain** - `worker.drain()` / `worker.stop({ drain: true })`
- **Dead Letter Queue** - Failed task management with replay lineage and an `onDlqEnqueue` alerting hook

### Email
- **Unified Adapters** - `@kahveciderin/concave/email` with **Resend** and **Cloudflare Email Service** adapters behind one `EmailAdapter` interface
- **Template Builder** - Fluent `createEmail().heading().button().code().build()` rendering responsive, escaped HTML + a plaintext fallback, with theming
- **Batch Sending** - `sendEmailBatch` for bulk delivery

### Billing
- **One Interface, Four Providers** - `@kahveciderin/concave/billing` over **Stripe**, **Lemon Squeezy**, **Paddle**, and **Polar.sh** (fetch-based, no SDK deps, Workers-safe)
- **Plans, One-Time & Usage** - Define subscription/one-time/usage plans by key; checkout, subscription management, `reportUsage`, hosted portal
- **Credits Ledger** - KV-backed atomic `grant`/`consume`/`balance`/`history`
- **Webhooks** - Per-provider signature verification, idempotent delivery dedupe, and automatic credit granting on `payment.succeeded`
- **Router & Client** - `createBillingRouter` plus `client.billing.*` and `useCredits`/`useSubscription`/`useCheckout` hooks

### Client Library
- **Type-safe Client** - Full TypeScript inference, `select` projections that narrow return types, typed filter builder, generated types from your API
- **React Hooks** - `useLiveList`, `useInfiniteList`, `useMutation`, `useSearch`, `useAuth`, `useJWTAuth`, `useFileUpload`/`useFile`/`useFiles`, `useCredits`/`useSubscription`/`useCheckout`, `usePublicEnv`, plus query invalidation and prefetch
- **React Native Support** - No DOM assumptions: pluggable `TokenStorage` (AsyncStorage-compatible), environment-aware transport and offline backends, `getDownloadUrl()` for native file handling
- **Resilient Transport** - Per-request `AbortSignal` + timeout, automatic 401 refresh-and-retry, SSE reconnect with jitter
- **Offline Support** - Optimistic updates, mutation queue, field-level merge, multi-tab coherence, IndexedDB backend
- **Auth Strategies** - OIDC (PKCE flow, token refresh), JWT, bearer, API key, or cookie sessions — selected per client or auto-detected
- **HMR-safe** - `getOrCreateClient` for development

### Environment Variables
- **Type-safe Configuration** - Define and validate env vars with Zod via `createEnv` / `envVariable`
- **Public and Private Vars** - `PUBLIC_`-prefixed or explicitly-marked vars served to clients via `usePublicEnv` (with ETag)
- **Client Access** - Typed `fetchPublicEnv` / `createEnvClient` and a `usePublicEnv` React hook

### Developer Experience
- **Project Scaffolding** - `npx concave create my-app` (Node/Workers templates, SQLite/Postgres), plus `concave generate resource|migration`
- **Deploy-Ready Output** - Generated Dockerfile, docker-compose, complete wrangler.toml, GitHub Actions CI, `.env.example`
- **Framework Migrations** - `@kahveciderin/concave/db` ships canonical internal-table schemas, an idempotent `autoMigrate`/`migrateInternal`, a generic seeder, and pool-sizing helpers
- **App Factory** - `createConcave()` wires errors, auth, security headers, health, OpenAPI, admin UI
- **Graceful Shutdown** - SIGTERM/SIGINT draining with `/readyz` 503 and clean SSE close
- **Admin UI** - Built-in dashboard at `/__concave/ui`
- **OpenAPI Generation** - Auto-generated specs from resources (filters, procedures, subscriptions, ETags)
- **Structured Logging** - Pluggable JSON logger with `CONCAVE_LOG_LEVEL` and `traceparent` propagation
- **Middleware** - Observability, versioning, idempotency, rate limiting
- **RFC 7807 Errors** - Problem+JSON everywhere, even without custom error handling

## Quick Start

### Scaffold a project

```bash
npx concave create my-app                          # Node + SQLite
npx concave create my-app --db postgres            # Node + PostgreSQL
npx concave create my-app --template cloudflare    # Cloudflare Workers + D1
```

### Or add to an existing app

```bash
npm install @kahveciderin/concave hono drizzle-orm zod @libsql/client
```

Define your schema:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").default("user"),
});
```

Create your API:

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createConcave } from "@kahveciderin/concave";
import { startServer } from "@kahveciderin/concave/node";
import { usersTable } from "./schema";

const client = createClient({ url: "file:./data.db" });
const db = drizzle(client);

const app = createConcave({ cors: true })
  .resource("/users", usersTable, { id: usersTable.id, db });

await startServer(app, { port: 3000 });
```

Health endpoints (`/healthz`, `/readyz`), OpenAPI (`/__concave/openapi.json`), the admin UI (`/__concave/ui`), and RFC 7807 error handling are wired automatically. The path is optional — `.resource(usersTable, config)` mounts at the table name.

### Cloudflare Workers

```typescript
import { drizzle } from "drizzle-orm/d1";
import { createConcave, ConcaveApp } from "@kahveciderin/concave";
import { usersTable } from "./schema";

let app: ConcaveApp | undefined;

export default {
  fetch(request: Request, env: { DB: D1Database }, ctx: ExecutionContext) {
    app ??= createConcave().resource("/users", usersTable, {
      id: usersTable.id,
      db: drizzle(env.DB),
    });
    return app.fetch(request, env, ctx);
  },
};
```

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "my-app"
```

Workers bill CPU time, not wall-clock time — long-lived idle SSE subscriptions cost almost nothing, since heartbeats and event pushes use negligible CPU.

For production Workers deployments, bind the bundled `ConcaveKVDurableObject` as Concave's KV store so subscriptions, rate limits, and sessions are shared across isolates — see [wiki/deployment.md](./wiki/deployment.md). Projects scaffolded with `concave create --template cloudflare` have it wired up already.

### Using a plain Hono app

`useResource` returns a regular Hono router — compose it however you like:

```typescript
import { Hono } from "hono";
import { useResource, errorHandler, notFoundHandler } from "@kahveciderin/concave";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.route("/api/users", useResource(usersTable, { id: usersTable.id, db }));

export default app;
```

### Generated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List with filtering, pagination |
| `GET` | `/api/users/:id` | Get single resource |
| `POST` | `/api/users` | Create resource |
| `PATCH` | `/api/users/:id` | Update resource (partial) |
| `PUT` | `/api/users/:id` | Replace resource |
| `DELETE` | `/api/users/:id` | Delete resource |
| `GET` | `/api/users/count` | Count with filtering |
| `GET` | `/api/users/aggregate` | Aggregations |
| `GET` | `/api/users/subscribe` | SSE subscription |
| `GET` | `/api/users/search` | Full-text search (when configured) |
| `POST` | `/api/users/batch` | Batch create |
| `PATCH` | `/api/users/batch` | Batch update |
| `DELETE` | `/api/users/batch` | Batch delete |
| `POST` | `/api/users/batch/upsert` | Bulk insert-or-update by primary key |
| `POST` | `/api/users/rpc/:name` | RPC procedures |

## Resource Configuration

Everything is opt-in per resource:

```typescript
app.resource("/posts", postsTable, {
  id: postsTable.id,
  db,

  // Batch operation limits
  batch: { create: 100, update: 100, delete: 100 },

  // Pagination settings
  pagination: { defaultLimit: 20, maxLimit: 100 },

  // Rate limiting
  rateLimit: { windowMs: 60000, maxRequests: 100 },

  // Optimistic locking (ETag / If-Match)
  etag: { versionField: "version" },

  // Authorization scopes (row-level security via RSQL)
  auth: {
    public: { read: true },
    update: async (user) => rsql`authorId=="${user.id}"`,
    delete: async (user) => rsql`authorId=="${user.id}"`,
  },

  // Relations
  relations: {
    author: {
      resource: "users",
      schema: usersTable,
      type: "belongsTo",
      foreignKey: postsTable.authorId,
      references: usersTable.id,
    },
    comments: {
      resource: "comments",
      schema: commentsTable,
      type: "hasMany",
      foreignKey: commentsTable.postId,
      references: postsTable.id,
    },
  },

  // Lifecycle hooks
  hooks: {
    onBeforeCreate: async (ctx, data) => ({ ...data, createdAt: new Date() }),
  },

  // RPC procedures
  procedures: {
    publish: defineProcedure({
      input: z.object({ id: z.string() }),
      output: z.object({ success: z.boolean() }),
      handler: async (ctx, input) => {
        await db.update(postsTable).set({ published: true }).where(eq(postsTable.id, input.id));
        return { success: true };
      },
    }),
  },
});
```

See [wiki/resources.md](./wiki/resources.md) for the full option reference (soft delete, computed fields, field allowlists, search, custom filter operators, and more).

## Client Library

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { useLiveList, useAuth } from "@kahveciderin/concave/client/react";

const client = getOrCreateClient({
  baseUrl: "https://api.myapp.com",
  credentials: "include",
  offline: true, // optimistic updates + mutation queue + persistence
});

function TodoApp() {
  const { user, isAuthenticated } = useAuth();
  const { items, status, mutate } = useLiveList<Todo>("/api/todos", {
    orderBy: "position",
  });

  return (
    <div>
      <p>Welcome, {user?.name}! ({status})</p>
      <ul>
        {items.map((todo) => (
          <li key={todo.id}>
            {todo.title}
            <button onClick={() => mutate.delete(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <button onClick={() => mutate.create({ title: "New todo" })}>Add</button>
    </div>
  );
}
```

`mutate.create/update/delete` apply optimistically, queue while offline, reconcile on sync, and every other subscribed client sees the change over SSE.

### Authentication options

The client supports OIDC (PKCE), JWT, bearer tokens, API keys, and cookie sessions. `useAuth({ strategy })` selects one explicitly, or auto-detects.

**JWT** (works in React Native — bring your own token storage):

```typescript
import { initJWTClient } from "@kahveciderin/concave/client/react";
import { useJWTAuth } from "@kahveciderin/concave/client/react";

initJWTClient({
  baseUrl: "https://api.myapp.com",
  // storage: AsyncStorage-backed TokenStorage for React Native;
  // defaults to localStorage in the browser
});

function LoginGate() {
  const { user, isAuthenticated, login, signup, logout } = useJWTAuth<User>();

  if (!isAuthenticated) {
    return <button onClick={() => login(email, password)}>Sign In</button>;
  }
  return <button onClick={logout}>Sign out, {user?.name}</button>;
}
```

**OIDC** (PKCE flow, token refresh, automatic 401 retry):

```typescript
const client = getOrCreateClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

client.auth.login(); // redirects to the provider
```

### Low-level API

```typescript
const users = client.resource<User>("/users");

// CRUD operations
const allUsers = await users.list({ filter: 'role=="admin"', limit: 10 });
const user = await users.get("123");
const newUser = await users.create({ name: "Alice", email: "alice@example.com" });
await users.update("123", { name: "Alice Smith" });
await users.delete("123");

// Real-time subscriptions
const subscription = users.subscribe(
  { filter: 'role=="admin"' },
  {
    onAdded: (user) => console.log("New admin:", user),
    onChanged: (user) => console.log("Updated:", user),
    onRemoved: (id) => console.log("Removed:", id),
    onInvalidate: () => console.log("Out-of-band change, refetching"),
    onConnected: (seq) => console.log("Live from sequence", seq),
    onError: (err) => console.error(err),
  }
);
```

### React Native

The client has no hard DOM dependencies: pass an AsyncStorage-backed `TokenStorage` for JWT auth, offline persistence picks an environment-appropriate backend, and the file hooks expose `getDownloadUrl()` for use with `Linking` instead of browser downloads.

## File Storage

Configure a storage backend once, then mount file resources like any other:

```typescript
import { initializeStorage, useFileResource } from "@kahveciderin/concave";

initializeStorage({
  type: "local", // or "s3" | "r2" | "memory"
  local: { basePath: "./uploads", baseUrl: "/uploads" },
});

app.route("/api/files", useFileResource(filesTable, {
  db,
  schema: filesTable,
  id: filesTable.id,
  allowedMimeTypes: ["image/jpeg", "image/png"],
  maxFileSize: 5 * 1024 * 1024,
  auth: {
    read: async (user) => rsql`userId==${user?.id}`,
    delete: async (user) => rsql`userId==${user?.id}`,
  },
  usePresignedUrls: true, // direct-to-bucket on S3/R2
}));
```

Upload from React with progress tracking:

```typescript
import { useFileUpload, useFiles } from "@kahveciderin/concave/client/react";

function Uploader() {
  const { upload, isUploading, progress } = useFileUpload({
    resourcePath: "/api/files",
    onSuccess: (file) => console.log("Uploaded", file.id),
  });

  return (
    <input
      type="file"
      disabled={isUploading}
      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
    />
  );
}
```

See [wiki/storage.md](./wiki/storage.md).

## Server-side Authentication

### Standard auth routes

```typescript
import { useAuth } from "@kahveciderin/concave/auth";

const { router, middleware } = useAuth({
  adapter: authAdapter, // JWT, Auth.js, Passport.js, or OIDC adapter
  login: { validateCredentials: async (email, password) => user },
  signup: { createUser: async ({ email, password, name }) => user },
});

app.route("/api/auth", router); // /me, /login, /signup, /logout
app.use("*", middleware);       // populates c.get("user")
```

Opt-in extras: TOTP MFA with backup codes, magic links, email verification, password reset, login throttling, CSRF protection, and API key management. See [wiki/authentication.md](./wiki/authentication.md).

### OIDC Provider

A complete OpenID Connect server, in your app:

```typescript
import { createOIDCProvider } from "@kahveciderin/concave";

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  tokens: {
    accessToken: { ttlSeconds: 3600 },
    refreshToken: { ttlSeconds: 30 * 24 * 3600, rotateOnUse: true },
  },
  clients: [{
    id: "web-app",
    name: "My Web App",
    redirectUris: ["https://myapp.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none", // public client, PKCE required
  }],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => { /* ... */ },
      findUserById: async (id) => { /* ... */ },
    },
    federated: [
      oidcProviders.google({ clientId: "...", clientSecret: "..." }),
    ],
  },
});

app.route("/oidc", router);
app.use("/api/*", middleware);
```

The provider exposes discovery, JWKS, `/authorize`, `/token`, `/userinfo`, `/logout`, plus RFC 7009 revocation (`/revoke`) and RFC 7662 introspection (`/introspect`). Confidential client secrets may be stored hashed (`scrypt$...`) and are verified with the built-in `hashPassword`/`verifyPassword` helpers.

## Background Tasks

Distributed task queue with retries and scheduling:

```typescript
import { defineTask, initializeTasks, getTaskScheduler, getTaskRegistry, startTaskWorkers } from "@kahveciderin/concave/tasks";
import { createKV } from "@kahveciderin/concave/kv";

const kv = await createKV({ type: "redis", redis: { url: "redis://localhost" } });
initializeTasks(kv);

const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  retry: { maxAttempts: 3, backoff: "exponential" },
  handler: async (ctx, input) => {
    await sendEmail(input.to, input.subject, input.body);
  },
});

getTaskRegistry().register(sendEmailTask);
await startTaskWorkers(kv, getTaskRegistry(), 3);

// Enqueue
await getTaskScheduler().enqueue(sendEmailTask, {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});

// Recurring
await getTaskScheduler().scheduleRecurring(dailyReportTask, {}, {
  cron: "0 6 * * *",
  timezone: "UTC",
});
```

On Workers, swap the poller for the Cloudflare Queues adapter. See [wiki/tasks.md](./wiki/tasks.md).

## Email

```typescript
import { setGlobalEmail, createResendAdapter, createEmail, sendEmail } from "@kahveciderin/concave/email";

setGlobalEmail(createResendAdapter({ apiKey: process.env.RESEND_API_KEY }));

const { html, text } = createEmail({ brandColor: "#4f46e5" })
  .heading("Verify your email")
  .text("Tap the button below to verify your account.")
  .button("Verify email", `https://acme.com/verify?token=${token}`)
  .divider()
  .code("123456")
  .build();

await sendEmail({ from: "noreply@acme.com", to: email, subject: "Verify your email", html, text });
```

The builder renders responsive, escaped HTML plus a plaintext fallback. A Cloudflare Email Service adapter is included for Workers. See [wiki/email.md](./wiki/email.md).

## Billing

One interface over Stripe, Lemon Squeezy, Paddle, and Polar.sh — fetch-based, no provider SDKs, Workers-safe:

```typescript
import { createBilling, createBillingRouter, createStripeAdapter } from "@kahveciderin/concave/billing";

const billing = createBilling({
  adapter: createStripeAdapter({ apiKey: env.STRIPE_SECRET_KEY }),
  webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  plans: [
    { key: "pro_monthly", priceId: "price_123", type: "subscription", credits: 10_000 },
  ],
});

app.route("/api/billing", createBillingRouter(billing, {
  getAccount: (c) => c.get("user")?.id,
  getCustomerEmail: (c) => c.get("user")?.email,
}));
```

```typescript
import { useCredits, useSubscription, useCheckout } from "@kahveciderin/concave/client/react";

function Account() {
  const { balance } = useCredits();
  const { activeSubscription } = useSubscription();
  const { redirectToCheckout, loading } = useCheckout();

  return (
    <div>
      <p>Credits: {balance}</p>
      <button onClick={() => redirectToCheckout({ plan: "pro_monthly" })} disabled={loading}>
        Upgrade
      </button>
    </div>
  );
}
```

Webhooks are signature-verified, deduplicated, and grant credits automatically on `payment.succeeded`. See [wiki/billing.md](./wiki/billing.md).

## Mutation Tracking

Custom routes participate in the realtime system by wrapping your db once:

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { trackMutations, readJsonBody, requireUser } from "@kahveciderin/concave";
import * as schema from "./schema";

const baseDb = drizzle(/* config */);

export const db = trackMutations(baseDb, {
  todos: { table: schema.todosTable, id: schema.todosTable.id },
  users: { table: schema.usersTable, id: schema.usersTable.id },
});

app.post("/api/custom-action", async (c) => {
  const body = await readJsonBody(c) as { title: string };
  const user = requireUser(c);

  const [todo] = await db
    .insert(schema.todosTable)
    .values({ title: body.title, userId: user.id })
    .returning();
  // recorded in the changelog — subscribers are notified

  return c.json(todo);
});
```

Optional query caching with automatic invalidation:

```typescript
const db = trackMutations(baseDb, tables, {
  cache: { enabled: true, ttl: 60000 },
});
```

For writers **outside** the tracked db — cron jobs, other services, manual edits — `recordExternalMutation` appends a changelog entry, invalidates the cache, and tells live subscribers to refetch. It's the portable alternative to database-specific CDC:

```typescript
import { recordExternalMutation } from "@kahveciderin/concave";

await recordExternalMutation("todos", "update", { objectId: "todo-1" });
```

## Typed Environment Variables

```typescript
import { createEnv, envVariable, usePublicEnv } from "@kahveciderin/concave";
import { z } from "zod";

const env = createEnv({
  PUBLIC_API_URL: z.string().url(),                       // PUBLIC_ prefix → exposed to clients
  SECRET_KEY: envVariable(process.env.SECRET, z.string()), // explicit source
  PORT: z.string().default("3000").transform(Number),
});

app.route("/api/env", usePublicEnv(env)); // serves public vars (with ETag)
```

Clients read public vars with `fetchPublicEnv`/`createEnvClient` or the `usePublicEnv` React hook. See [wiki/environment-variables.md](./wiki/environment-variables.md).

## Query Parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `filter` | `age>=18;role=="admin"` | RSQL filter expression |
| `select` | `id,name,email` | Field projection |
| `include` | `author,comments(limit:5)` | Related data to load |
| `cursor` | `eyJpZCI6MTB9` | Pagination cursor |
| `limit` | `20` | Page size |
| `orderBy` | `name:asc,age:desc` | Sort order |
| `totalCount` | `true` | Include total count |
| `having` | `count>=5;sum_amount>100` | Filter aggregate groups (`/aggregate` only) |
| `withDeleted` | `true` | Include soft-deleted rows (when `softDelete` is configured) |

## Filter Syntax

```bash
# Comparison
name=="John"              # Equals
age>=18                   # Greater than or equal
status!="deleted"         # Not equals

# Logical operators
age>=18;role=="admin"     # AND (semicolon)
role=="admin",role=="mod" # OR (comma)
(age>=18;verified==true),role=="admin"  # Grouping

# String operations
name=icontains="john"     # Case-insensitive contains
email=iendswith="@company.com"
title=istartswith="how to"

# Set and range
role=in=("admin","mod")   # In list
age=between=[18,65]       # Range (inclusive)

# Null and empty
deletedAt=isnull=true     # Is null
bio=isempty=false         # Has non-empty value

# See wiki/filtering.md for all 30+ operators
```

The same expression filters database queries, subscription scopes, and auth scopes — parsed once, executed as SQL or in-memory as needed.

## Error Handling

All errors follow [RFC 7807 Problem Details](https://tools.ietf.org/html/rfc7807) format:

```json
{
  "type": "/__concave/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "users with id '123' not found",
  "code": "NOT_FOUND",
  "resource": "users",
  "id": "123"
}
```

Error types include:
- `not-found` (404) - Resource not found
- `validation-error` (400) - Invalid input data
- `unauthorized` (401) - Authentication required
- `forbidden` (403) - Insufficient permissions
- `rate-limit-exceeded` (429) - Too many requests
- `batch-limit-exceeded` (400) - Batch size exceeded
- `filter-parse-error` (400) - Invalid filter syntax
- `cursor-invalid` (400) - Malformed pagination cursor
- `precondition-failed` (412) - ETag mismatch

Errors extend Hono's `HTTPException` and self-render — resources mounted in any Hono app return proper problem+json without extra setup.

## Testing

```bash
npm test                                           # all tests
npm test -- tests/integration/useResource.test.ts  # one file
npm test -- --coverage
```

Testing your own app needs no HTTP server:

```typescript
const res = await app.request("/api/users", {
  method: "POST",
  body: JSON.stringify({ name: "Alice", email: "a@b.com" }),
  headers: { "content-type": "application/json" },
});
expect(res.status).toBe(201);
```

## Documentation

Comprehensive documentation is available in the [wiki](./wiki):

### Getting Started
- [Getting Started Guide](./wiki/getting-started.md) - Installation and quick start
- [Deployment](./wiki/deployment.md) - Node, Cloudflare Workers, database matrix
- [Migrating from Express](./wiki/migrating-from-express.md) - Upgrading from Concave ≤ 0.5

### Core Concepts
- [Resources](./wiki/resources.md) - Resource configuration and endpoints
- [Filtering](./wiki/filtering.md) - RSQL filter syntax (30+ operators)
- [Pagination](./wiki/pagination.md) - Cursor-based pagination
- [Aggregations](./wiki/aggregations.md) - Group by and statistical queries
- [Relations](./wiki/relations.md) - Relationships and efficient batch loading
- [Search](./wiki/search.md) - Full-text search adapters and transactional outbox
- [Database](./wiki/database.md) - Internal tables, framework migrations, seeding, pooling

### Real-time
- [Subscriptions](./wiki/subscriptions.md) - SSE subscriptions and changelog

### Authentication & Security
- [Authentication](./wiki/authentication.md) - OIDC Provider, federated login, JWT, session auth
- [Secure Queries](./wiki/secure-queries.md) - Scope-enforced query builder

### Platform Services
- [Storage](./wiki/storage.md) - File uploads, S3/R2/local adapters, presigned URLs
- [Email](./wiki/email.md) - Email adapters and template builder
- [Billing](./wiki/billing.md) - Payment providers, plans, credits, webhooks
- [Tasks](./wiki/tasks.md) - Background job queue, scheduling, retries
- [Environment Variables](./wiki/environment-variables.md) - Typed env config

### Client
- [Client Library](./wiki/client-library.md) - TypeScript client with React hooks
- [Offline Support](./wiki/offline-support.md) - Offline-first capabilities

### Advanced
- [Procedures & Hooks](./wiki/procedures.md) - RPC and lifecycle hooks
- [Mutation Tracking](./wiki/track-mutations.md) - Automatic changelog and cache invalidation
- [Middleware](./wiki/middleware.md) - Observability, versioning, idempotency
- [OpenAPI](./wiki/openapi.md) - OpenAPI spec generation
- [Admin UI](./wiki/admin-ui.md) - Built-in dashboard
- [Error Handling](./wiki/error-handling.md) - Error types and handling

## Requirements

- Node.js 18+ or Cloudflare Workers (`nodejs_compat`)
- TypeScript 5+
- Drizzle ORM
- Hono 4+
