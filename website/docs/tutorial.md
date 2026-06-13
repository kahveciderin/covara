---
id: tutorial
title: "Tutorial: a real-time todo app"
sidebar_label: Tutorial
description: Build a complete real-time todo app with Covara — schema, auth, relations, search, file uploads, live aggregations, and a React client.
---

# Tutorial: a real-time todo app

This tutorial builds a complete app end to end: authenticated users with private todos, categories and tags (relations), image uploads, full-text search, and a React UI that updates in real time with optimistic mutations. It mirrors the project under [`example/`](https://github.com/kahveciderin/covara/tree/master/example) in the repo.

By the end you'll have used: [resources](./core/resources-and-app.md), [auth scopes](./auth/scopes.md), [relations](./core/relations.md), [lifecycle hooks](./core/procedures.md), [file storage](./platform/storage.md), [search](./core/search.md), [live subscriptions](./realtime/subscriptions.md), and [live aggregations](./realtime/aggregate-subscriptions.md).

## 1. Schema

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const categoriesTable = sqliteTable("categories", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const todosTable = sqliteTable("todos", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  completed: integer("completed", { mode: "boolean" }).default(false),
  position: integer("position").notNull(),
  categoryId: text("categoryId"),
  imageId: text("imageId"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const tagsTable = sqliteTable("tags", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
});

export const todoTagsTable = sqliteTable("todo_tags", {
  todoId: text("todoId").notNull(),
  tagId: text("tagId").notNull(),
});

export const filesTable = sqliteTable("files", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  key: text("key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("contentType").notNull(),
  size: integer("size").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
```

## 2. Database

```typescript
// src/db/db.ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: process.env.DB_FILE_NAME ?? "file:./data.db" });
export const db = drizzle(client);
```

Push the schema with [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview): `npx drizzle-kit push`.

## 3. Authentication

We use the [Passport adapter](./auth/sessions.md) with a session store, plus [`useAuth`](./auth/overview.md) to mount `/login`, `/signup`, `/logout`, and `/me`.

```typescript
// src/auth.ts
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  useAuth,
  createPassportAdapter,
  hashPassword,
  verifyPassword,
  ValidationError,
} from "covara";
import { db } from "./db/db";
import { usersTable } from "./db/schema";

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return user ?? null;
  },
});

export const auth = useAuth({
  adapter: authAdapter,
  login: {
    validateCredentials: async (email, password) => {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
      return { id: user.id, email: user.email, name: user.name };
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (existing.length > 0) throw new ValidationError("Email already registered");
      const [user] = await db
        .insert(usersTable)
        .values({
          id: randomUUID(),
          email,
          name: name ?? "User",
          passwordHash: await hashPassword(password),
          createdAt: new Date(),
        })
        .returning();
      return { id: user.id, email: user.email, name: user.name };
    },
  },
});
```

`hashPassword`/`verifyPassword` are Covara's built-in scrypt helpers — see [Passwords](./auth/passwords.md).

## 4. Resources

Now the heart of the app. Every resource scopes reads/writes to the current user with [RSQL scopes](./auth/scopes.md), and `todos` declares [relations](./core/relations.md) to categories, files, and tags.

```typescript
// src/main.ts
import { randomUUID } from "node:crypto";
import { eq, max } from "drizzle-orm";
import {
  createCovara,
  rsql,
  UnauthorizedError,
  initializeKV,
  initializeStorage,
  useFileResource,
} from "covara";
import { startServer } from "covara/node";
import { db } from "./db/db";
import { auth } from "./auth";
import {
  usersTable, todosTable, categoriesTable, tagsTable, todoTagsTable, filesTable,
} from "./db/schema";

await initializeKV({ type: "memory", prefix: "todo-app" });
initializeStorage({ type: "local", local: { basePath: "./.tmp/uploads", baseUrl: "/uploads" } });

const app = createCovara({ auth, cors: true })
  .resource("/categories", categoriesTable, {
    id: categoriesTable.id,
    db,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "createdAt"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        return { ...data, id: randomUUID(), userId: ctx.user.id, createdAt: new Date() };
      },
    },
  })
  .resource("/tags", tagsTable, {
    id: tagsTable.id,
    db,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        return { ...data, id: randomUUID(), userId: ctx.user.id };
      },
    },
  })
  .resource("/todos", todosTable, {
    id: todosTable.id,
    db,
    pagination: { defaultLimit: 100, maxLimit: 500 },
    search: {
      enabled: true,
      fields: { title: { weight: 2.0 }, description: { weight: 1.0 } },
    },
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
      subscribe: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "position", "createdAt", "updatedAt"],
    relations: {
      category: {
        resource: "categories", schema: categoriesTable, type: "belongsTo",
        foreignKey: todosTable.categoryId, references: categoriesTable.id,
      },
      image: {
        resource: "files", schema: filesTable, type: "belongsTo",
        foreignKey: todosTable.imageId, references: filesTable.id,
      },
      tags: {
        resource: "tags", schema: tagsTable, type: "manyToMany",
        foreignKey: todosTable.id, references: tagsTable.id,
        through: { schema: todoTagsTable, sourceKey: todoTagsTable.todoId, targetKey: todoTagsTable.tagId },
      },
    },
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        const [maxPos] = await db
          .select({ max: max(todosTable.position) })
          .from(todosTable)
          .where(eq(todosTable.userId, ctx.user.id));
        return {
          ...data, id: randomUUID(), userId: ctx.user.id,
          position: (maxPos?.max ?? -1) + 1, createdAt: new Date(), updatedAt: new Date(),
        };
      },
      onBeforeUpdate: async (_ctx, _id, data) => ({ ...data, updatedAt: new Date() }),
    },
  });
```

A few things worth noting:

- **`generatedFields`** marks columns the server fills in (id, userId, timestamps), so the client never has to send them and they are stripped from inbound payloads.
- **`onBeforeCreate`** is where ownership is stamped — `ctx.user.id` is the authenticated user from the session middleware.
- **`auth.subscribe`** scopes the SSE stream, so a user only sees real-time changes to their own todos.
- **`search`** registers `title`/`description` as searchable; the actual index depends on the [search adapter](./core/search.md) you configure.

## 5. File uploads

Mount a [file resource](./platform/storage.md). It generates upload/download/list/delete endpoints with MIME and size validation.

```typescript
app.route(
  "/api/files",
  useFileResource(filesTable, {
    db,
    schema: filesTable,
    id: filesTable.id,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    maxFileSize: 5 * 1024 * 1024,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      delete: async (user) => rsql`userId==${user?.id}`,
    },
  })
);

await startServer(app, { port: 3000 });
```

## 6. The React client

```tsx
// frontend/src/App.tsx
import { getOrCreateClient } from "covara/client";
import {
  useAuth, useLiveList, useLiveAggregate, useSearch, useFileUpload,
} from "covara/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});

function TodoApp() {
  // Live, paginated list with relations included — updates in real time.
  const { items: todos, status, mutate, hasMore, loadMore } = useLiveList<Todo>("/api/todos", {
    orderBy: "position",
    include: ["category", "image", "tags"],
    limit: 5,
  });

  // Live aggregation across ALL todos (not just the loaded page),
  // recomputed on the server on every change.
  const { groups } = useLiveAggregate("/api/todos", { groupBy: ["completed"], count: true });
  const completed = groups.find((g) => g.key?.completed === true)?.count ?? 0;

  const addTodo = (title: string) => mutate.create({ title }); // optimistic
  const toggle = (t: Todo) => mutate.update(t.id, { completed: !t.completed });

  return (
    <ul>
      {todos.map((t) => (
        <li key={t.id}>
          <input type="checkbox" checked={t.completed} onChange={() => toggle(t)} />
          {t.title} {t.category && <em>{t.category.name}</em>}
          <button onClick={() => mutate.delete(t.id)}>×</button>
        </li>
      ))}
      {hasMore && <button onClick={loadMore}>Load more</button>}
    </ul>
  );
}
```

`mutate.create`/`update`/`delete` apply **optimistically** (instant UI), queue while offline, and reconcile against the server response. Every change streams to all connected clients via the subscription. See [Live queries](./client/live-queries.md) and [Offline](./client/offline.md).

### Type safety end to end

Generate types from the running API and wrap the client to get fully-typed resource accessors and a fluent query builder:

```bash
npx covara generate types --url http://localhost:3000 --out src/generated/api-types.ts
```

```tsx
import { createTypedClient } from "./generated/api-types";
const typed = createTypedClient(client);

const { items } = useLiveList(
  typed.resources.todos.orderBy("position").include("category", "tags").limit(5)
); // items is fully typed, including the included relations
```

See [Type generation](./client/typegen.md).

## Where to go next

- Add **[optimistic locking](./core/optimistic-locking.md)** to prevent lost updates.
- Add **[background tasks](./platform/tasks.md)** to send a daily digest email.
- Add **[billing](./platform/billing.md)** to gate premium features.
- **[Deploy](./deployment/node.md)** to Node or Cloudflare Workers.
