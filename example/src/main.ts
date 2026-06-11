import { eq, count, desc, max } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { serveStatic } from "@hono/node-server/serve-static";

import {
  rsql,
  createMetricsCollector,
  createAdminUI,
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
  useFileResource,
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

const app = createCovara({
  observability: { metrics: metricsCollector },
  auth,
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
  });

app.route("/api/env", usePublicEnv(env));

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

app.use(
  "/uploads/*",
  serveStatic({
    root: uploadsDir,
    rewriteRequestPath: (p) => p.replace(/^\/uploads/, ""),
  })
);

app.route(
  "/__covara",
  createAdminUI({
    title: "Todo App Admin",
    metricsCollector,
    changelog: {
      getCurrentSequence: () => changelog.getCurrentSequence(),
      getEntries: (fromSeq, limit) =>
        changelog.getEntriesInRange(fromSeq, limit),
    },
    // Security configuration - development mode allows unauthenticated access
    security: {
      mode:
        (process.env.NODE_ENV as "development" | "staging" | "production") ||
        "development",
      auth: {
        // In development, auth is disabled by default
        // In production, you'd set an API key: apiKey: process.env.ADMIN_API_KEY
        disabled: process.env.NODE_ENV !== "production",
      },
    },
    // Data explorer configuration
    dataExplorer: {
      enabled: true,
      readOnly: process.env.NODE_ENV === "production",
      excludeFields: {
        users: ["passwordHash"], // Hide password hashes
      },
      maxLimit: 100,
    },
    // KV inspector configuration
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
        return { users, total: totalResult[0]?.total ?? 0 };
      },
      getUser: async (id) => {
        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, id))
          .limit(1);
        return user ?? null;
      },
      createUser: async (data) => {
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
      updateUser: async (id, data) => {
        const [user] = await db
          .update(usersTable)
          .set(data)
          .where(eq(usersTable.id, id))
          .returning();
        return user;
      },
      deleteUser: async (id) => {
        await db.delete(usersTable).where(eq(usersTable.id, id));
      },
    },
    sessionManager: {
      listSessions: async () => {
        const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
        return sessions.map((s) => ({
          sessionToken: s.id,
          userId: s.userId,
          expires: s.expiresAt,
          createdAt: s.createdAt,
        }));
      },
      getSessionsByUser: async (userId) => {
        const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
        return sessions
          .filter((s) => s.userId === userId)
          .map((s) => ({
            sessionToken: s.id,
            userId: s.userId,
            expires: s.expiresAt,
          }));
      },
      createSession: async (userId, expiresIn = 86400000) => {
        const session = await authAdapter.createSession(userId);
        return { token: session.id, expiresAt: session.expiresAt };
      },
      revokeSession: async (sessionId) => {
        await authAdapter.invalidateSession(sessionId);
      },
      revokeAllUserSessions: async (userId) => {
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
  })
);

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
