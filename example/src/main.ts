import { eq, count, desc, max } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { serveStatic } from "@hono/node-server/serve-static";

import {
  rsql,
  createMetricsCollector,
  createCovara,
  createPassportAdapter,
  useAuth,
  UnauthorizedError,
  ValidationError,
  changelog,
  initializeKV,
  getGlobalKV,
  usePublicEnv,
  setGlobalSearch,
  createOpenSearchAdapter,
  initializeStorage,
} from "covara";
import { startServer } from "covara/node";

import { env } from "./config/config";
import {
  usersTable,
  todosTable,
  categoriesTable,
  tagsTable,
  todoTagsTable,
  filesTable,
} from "./db/schema";
import { db } from "./db/db";
import { todoHtmxPage } from "./htmx-page";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initializeKV({ type: "memory", prefix: "todo-app" });

const uploadsDir = path.join(__dirname, "../.tmp/uploads");
initializeStorage({
  type: "local",
  local: {
    basePath: uploadsDir,
    baseUrl: "/uploads",
  },
});

if (env.searchConfig.opensearchUrl) {
  setGlobalSearch(
    await createOpenSearchAdapter({
      node: env.searchConfig.opensearchUrl,
      indexPrefix: "todoapp_",
    })
  );
}

const hashPassword = (password: string): string => {
  return createHash("sha256").update(password).digest("hex");
};

const metricsCollector = createMetricsCollector({
  maxMetrics: 1000,
});

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    return user ?? null;
  },
});

const auth = useAuth({
  adapter: authAdapter,
  login: {
    validateCredentials: async (email, password) => {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (!user || user.passwordHash !== hashPassword(password)) {
        return null;
      }
      return { id: user.id, email: user.email, name: user.name };
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const existing = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (existing.length > 0) {
        throw new ValidationError("Email already registered");
      }

      const id = randomUUID();
      const [user] = await db
        .insert(usersTable)
        .values({
          id,
          email,
          name: name ?? "User",
          passwordHash: hashPassword(password),
        })
        .returning();

      return { id: user.id, email: user.email, name: user.name };
    },
    validateEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    validatePassword: (password) => password.length >= 6,
  },
});

// Admin UI config — passed to createCovara so it auto-mounts the dashboard,
// wires live request/subscription/changelog data, and captures all API traffic.
const adminUI = {
  title: "Todo App Admin",
  metricsCollector,
  // Security configuration - development mode allows unauthenticated access
  security: {
    mode:
      (process.env.NODE_ENV as "development" | "staging" | "production") ||
      "development",
    auth: {
      disabled: process.env.NODE_ENV !== "production",
    },
  },
  dataExplorer: {
    enabled: true,
    readOnly: process.env.NODE_ENV === "production",
    excludeFields: {
      users: ["passwordHash"],
    },
    maxLimit: 100,
  },
  kvInspector: {
    enabled: process.env.NODE_ENV !== "production",
    kv: getGlobalKV(),
    readOnly: process.env.NODE_ENV === "staging",
  },
  userManager: {
    listUsers: async (limit = 50, offset = 0) => {
      const [users, totalResult] = await Promise.all([
        db
          .select({
            id: usersTable.id,
            email: usersTable.email,
            name: usersTable.name,
            createdAt: usersTable.createdAt,
          })
          .from(usersTable)
          .limit(limit)
          .offset(offset)
          .orderBy(desc(usersTable.createdAt)),
        db.select({ total: count() }).from(usersTable),
      ]);
      const withLastLogin = await Promise.all(
        users.map(async (u) => {
          const sessions =
            (await authAdapter.sessionStore.getByUser?.(u.id)) ?? [];
          const lastLoginAt = sessions.reduce<Date | undefined>(
            (latest, s) =>
              !latest || s.createdAt > latest ? s.createdAt : latest,
            undefined
          );
          return { ...u, lastLoginAt };
        })
      );
      return { users: withLastLogin, total: totalResult[0]?.total ?? 0 };
    },
    getUser: async (id: string) => {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      return user ?? null;
    },
    createUser: async (data: { email: string; name?: string }) => {
      const [user] = await db
        .insert(usersTable)
        .values({
          id: randomUUID(),
          email: data.email,
          name: data.name || "User",
          passwordHash: hashPassword("password123"),
        })
        .returning();
      return user;
    },
    updateUser: async (id: string, data: { email?: string; name?: string }) => {
      const [user] = await db
        .update(usersTable)
        .set(data)
        .where(eq(usersTable.id, id))
        .returning();
      return user;
    },
    deleteUser: async (id: string) => {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    },
  },
  sessionManager: {
    listSessions: async () => {
      const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
      return sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        data: s.data,
      }));
    },
    getSessionsByUser: async (userId: string) => {
      const sessions =
        (await authAdapter.sessionStore.getByUser?.(userId)) ?? [];
      return sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        data: s.data,
      }));
    },
    createSession: async (userId: string) => {
      const session = await authAdapter.createSession(userId);
      return { token: session.id, expiresAt: session.expiresAt };
    },
    revokeSession: async (sessionId: string) => {
      await authAdapter.invalidateSession(sessionId);
    },
    revokeAllUserSessions: async (userId: string) => {
      const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
      let revokedCount = 0;
      for (const s of sessions) {
        if (s.userId === userId) {
          await authAdapter.invalidateSession(s.id);
          revokedCount++;
        }
      }
      return revokedCount;
    },
  },
};

const app = createCovara({
  observability: { metrics: metricsCollector },
  auth,
  adminUI,
  health: {
    version: "1.0.0",
    checks: {
      kv: getGlobalKV(),
    },
    thresholds: {
      eventLoopLagMs: 100,
      memoryPercent: 90,
    },
  },
})
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
        return {
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          createdAt: new Date(),
        };
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
    generatedFields: ["id", "userId", "createdAt"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        return {
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          createdAt: new Date(),
        };
      },
    },
  })
  .resource("/todos", todosTable, {
    id: todosTable.id,
    db,
    pagination: { defaultLimit: 100, maxLimit: 500 },
    search: {
      enabled: true,
      fields: {
        title: { weight: 2.0 },
        description: { weight: 1.0 },
      },
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
        resource: "categories",
        schema: categoriesTable,
        type: "belongsTo",
        foreignKey: todosTable.categoryId,
        references: categoriesTable.id,
      },
      image: {
        resource: "files",
        schema: filesTable,
        type: "belongsTo",
        foreignKey: todosTable.imageId,
        references: filesTable.id,
      },
      tags: {
        resource: "tags",
        schema: tagsTable,
        type: "manyToMany",
        foreignKey: todosTable.id,
        references: tagsTable.id,
        through: {
          schema: todoTagsTable,
          sourceKey: todoTagsTable.todoId,
          targetKey: todoTagsTable.tagId,
        },
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
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          position: (maxPos?.max ?? -1) + 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      onBeforeUpdate: async (_ctx, _id, data) => ({
        ...data,
        updatedAt: new Date(),
      }),
    },
  })
  // Server-rendered htmx view of the same todos, served alongside the React SPA
  // at /htmx. Shares the cookie session, so it's scoped to the logged-in user.
  .page("/htmx", todoHtmxPage);

app.route("/api/env", usePublicEnv(env));

// File resources are first-class resources with an upload/download layer — they
// chain like any other resource and gain hooks, relations, subscriptions, etc.
app.fileResource("/files", filesTable, {
  db,
  id: filesTable.id,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  maxFileSize: 5 * 1024 * 1024,
  auth: {
    read: async (user) => rsql`userId==${user?.id}`,
    create: async (user) => (user ? rsql`*` : rsql``),
    delete: async (user) => rsql`userId==${user?.id}`,
  },
});

// Local uploads are auto-served at the storage baseUrl (/uploads) by
// createCovara — no manual serveStatic wiring needed.

const publicDir = path.join(__dirname, "../public");
app.use("*", serveStatic({ root: publicDir }));

const spaFallback = serveStatic({ root: publicDir, path: "index.html" });
app.get("*", (c, next) => {
  if (c.req.path.startsWith("/api") || c.req.path.startsWith("/__covara")) {
    return next();
  }
  return spaFallback(c, next);
});

await startServer(app, {
  port: env.serverConfig.port,
  onListen: ({ port }) => {
    console.log(`
=============================================
  Todo App (powered by Covara)
=============================================
  App:   http://localhost:${port}
  Admin: http://localhost:${port}/__covara/ui
=============================================
  `);
  },
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
