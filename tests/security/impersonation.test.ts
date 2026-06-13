import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { rsql, emptyScope } from "@/auth/rsql";
import {
  markImpersonate,
  setImpersonationPredicate,
  setImpersonationUserResolver,
  createImpersonationMiddleware,
} from "@/server/impersonation";
import {
  markAdminBypass,
  setAdminBypassPredicate,
} from "@/server/admin-bypass";
import { createAdminBypassPredicate } from "@/ui/admin-auth";
import type { UserContext } from "@/resource/types";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const docsTable = sqliteTable("imp_docs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  userId: text("userId").notNull(),
});

const mkUser = (
  id: string,
  metadata?: Record<string, unknown>
): UserContext => ({
  id,
  email: `${id}@test.com`,
  name: id,
  image: null,
  emailVerified: null,
  sessionId: "s",
  sessionExpiresAt: new Date(Date.now() + 3600000),
  metadata,
});

const USERS: Record<string, UserContext> = {
  admin1: mkUser("admin1", { roles: ["admin"] }),
  admin2: mkUser("admin2", { roles: ["admin"] }),
  user1: mkUser("user1"),
  user2: mkUser("user2"),
  user3: mkUser("user3"),
};

describe("Admin user impersonation", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  const buildApp = (real: { id: string; metadata?: Record<string, unknown> }) => {
    const app = createTestApp({
      user: real,
      middleware: [createImpersonationMiddleware()],
    });
    app.route(
      "/docs",
      useResource(docsTable, {
        id: docsTable.id,
        db,
        auth: {
          read: async (u) => rsql`userId==${u.id}`,
          create: async (u) => rsql`userId==${u.id}`,
          update: async (u) => rsql`userId==${u.id}`,
          delete: async (u) => rsql`userId==${u.id}`,
        },
      })
    );
    return app;
  };

  beforeEach(async () => {
    const adminPredicate = createAdminBypassPredicate({ requireRole: "admin" });
    setImpersonationPredicate(adminPredicate);
    setImpersonationUserResolver(async (id) => USERS[id] ?? null);
    setAdminBypassPredicate(adminPredicate);

    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE imp_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        userId TEXT NOT NULL
      )
    `);
    for (const owner of ["user1", "user2", "user3"]) {
      await libsqlClient.execute(
        `INSERT INTO imp_docs (title, userId) VALUES ('${owner} doc', '${owner}')`
      );
    }
  });

  afterEach(() => {
    setImpersonationPredicate(null);
    setImpersonationUserResolver(null);
    setAdminBypassPredicate(null);
    libsqlClient.close();
  });

  it("ignores the impersonate header from a non-admin (forged header is inert)", async () => {
    const app = buildApp({ id: "user1" });
    const res = await get(app, "/docs", markImpersonate("user2"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe("user1");
  });

  it("swaps the effective user when an admin impersonates (their scope, not bypass)", async () => {
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const res = await get(app, "/docs", markImpersonate("user2"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe("user2");
  });

  it("does not stack with admin bypass — impersonation wins", async () => {
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const res = await get(app, "/docs", {
      ...markImpersonate("user2"),
      ...markAdminBypass(),
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe("user2");
  });

  it("does not escalate when impersonating an admin (no bypass)", async () => {
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const res = await get(app, "/docs", {
      ...markImpersonate("admin2"),
      ...markAdminBypass(),
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("attributes writes to the impersonated user", async () => {
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const created = await post(
      app,
      "/docs",
      { title: "by admin as user2", userId: "user2" },
      markImpersonate("user2")
    );
    expect(created.status).toBe(201);

    const seen = await get(app, "/docs", markImpersonate("user2"));
    expect(seen.body.items.map((i: any) => i.title)).toContain("by admin as user2");
  });

  it("enforces the impersonated user's create scope (403 when denied)", async () => {
    const app = createTestApp({
      user: { id: "admin1", metadata: { roles: ["admin"] } },
      middleware: [createImpersonationMiddleware()],
    });
    app.route(
      "/locked",
      useResource(docsTable, {
        id: docsTable.id,
        db,
        auth: {
          read: async (u) => rsql`userId==${u.id}`,
          create: async () => emptyScope(),
        },
      })
    );
    const denied = await post(
      app,
      "/locked",
      { title: "x", userId: "user2" },
      markImpersonate("user2")
    );
    expect(denied.status).toBe(403);
  });

  it("is inert when no resolver is registered", async () => {
    setImpersonationUserResolver(null);
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const res = await get(app, "/docs", markImpersonate("user2"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("updates another user's row only within the impersonated scope", async () => {
    const app = buildApp({ id: "admin1", metadata: { roles: ["admin"] } });
    const ok = await patch(
      app,
      "/docs/2",
      { title: "edited as user2" },
      markImpersonate("user2")
    );
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe("edited as user2");

    const blocked = await patch(
      app,
      "/docs/1",
      { title: "nope" },
      markImpersonate("user2")
    );
    expect(blocked.status).toBe(404);

    const removed = await del(app, "/docs/1", undefined, markImpersonate("user2"));
    expect(removed.status).toBe(404);
  });
});
