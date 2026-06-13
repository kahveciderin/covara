import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { rsql, emptyScope } from "@/auth/rsql";
import {
  markAdminBypass,
  setAdminBypassPredicate,
} from "@/server/admin-bypass";
import { createAdminBypassPredicate } from "@/ui/admin-auth";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const docsTable = sqliteTable("bypass_docs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  userId: text("userId").notNull(),
});

const adminMeta = { roles: ["admin"] };

describe("Admin scope bypass (identity-verified)", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  const buildApp = (user: { id: string; metadata?: Record<string, unknown> }) => {
    const app = createTestApp({ user });
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
    setAdminBypassPredicate(createAdminBypassPredicate({ requireRole: "admin" }));
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE bypass_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        userId TEXT NOT NULL
      )
    `);
    await libsqlClient.execute(
      "INSERT INTO bypass_docs (title, userId) VALUES ('user1 doc', 'user1')"
    );
    await libsqlClient.execute(
      "INSERT INTO bypass_docs (title, userId) VALUES ('user2 doc', 'user2')"
    );
    await libsqlClient.execute(
      "INSERT INTO bypass_docs (title, userId) VALUES ('user3 doc', 'user3')"
    );
  });

  afterEach(() => {
    setAdminBypassPredicate(null);
    libsqlClient.close();
  });

  it("scopes list to the current user without the marker (control)", async () => {
    const app = buildApp({ id: "user1" });
    const res = await get(app, "/docs");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe("user1");
  });

  it("returns all rows for an admin carrying the marker", async () => {
    const app = buildApp({ id: "admin1", metadata: adminMeta });
    const res = await get(app, "/docs", markAdminBypass());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });

  it("does NOT bypass when a non-admin sends the marker (leaked marker is useless)", async () => {
    const app = buildApp({ id: "user1" });
    const res = await get(app, "/docs", markAdminBypass());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe("user1");
  });

  it("does NOT bypass for an admin without the marker (opt-in required)", async () => {
    const app = buildApp({ id: "admin1", metadata: adminMeta });
    const res = await get(app, "/docs");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("does NOT bypass when no predicate is registered (standalone useResource)", async () => {
    setAdminBypassPredicate(null);
    const app = buildApp({ id: "admin1", metadata: adminMeta });
    const res = await get(app, "/docs", markAdminBypass());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("lets an admin read/update/delete another user's row", async () => {
    const app = buildApp({ id: "admin1", metadata: adminMeta });

    const read = await get(app, "/docs/2", markAdminBypass());
    expect(read.status).toBe(200);
    expect(read.body.userId).toBe("user2");

    const updated = await patch(
      app,
      "/docs/2",
      { title: "edited by admin" },
      markAdminBypass()
    );
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("edited by admin");

    const deleted = await del(app, "/docs/3", undefined, markAdminBypass());
    expect(deleted.status).toBe(204);
  });

  it("skips the create permission check for an admin under the marker", async () => {
    const app = createTestApp({ user: { id: "admin1", metadata: adminMeta } });
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

    const denied = await post(app, "/locked", { title: "x", userId: "admin1" });
    expect(denied.status).toBe(403);

    const allowed = await post(
      app,
      "/locked",
      { title: "by admin", userId: "user9" },
      markAdminBypass()
    );
    expect(allowed.status).toBe(201);
    expect(allowed.body.userId).toBe("user9");
  });

  it("counts all rows for an admin under the marker", async () => {
    const app = buildApp({ id: "admin1", metadata: adminMeta });
    const scoped = await get(app, "/docs/count");
    expect(scoped.body.count).toBe(0);

    const bypassed = await get(app, "/docs/count", markAdminBypass());
    expect(bypassed.body.count).toBe(3);
  });
});

describe("createAdminBypassPredicate", () => {
  const ctx = (headers: Record<string, string> = {}) =>
    ({
      req: { header: (k: string) => headers[k.toLowerCase()] },
    }) as any;

  const userWith = (metadata?: Record<string, unknown>) => ({
    id: "u1",
    email: "u1@test.com",
    name: null,
    image: null,
    emailVerified: null,
    sessionId: "s1",
    sessionExpiresAt: new Date(Date.now() + 3600000),
    metadata,
  });

  it("grants when the user holds the required role", async () => {
    const pred = createAdminBypassPredicate({ requireRole: "admin" });
    expect(await pred(userWith({ roles: ["admin"] }), ctx())).toBe(true);
    expect(await pred(userWith({ roles: ["member"] }), ctx())).toBe(false);
    expect(await pred(null, ctx())).toBe(false);
  });

  it("honors a custom authorize callback", async () => {
    const pred = createAdminBypassPredicate({
      authorize: async (u) => u.email === "u1@test.com",
    });
    expect(await pred(userWith(), ctx())).toBe(true);
    const denyPred = createAdminBypassPredicate({ authorize: async () => false });
    expect(await denyPred(userWith(), ctx())).toBe(false);
  });

  it("accepts the operator's admin API key from the forwarded headers", async () => {
    const pred = createAdminBypassPredicate({ auth: { apiKey: "secret-key" } });
    expect(await pred(null, ctx({ "x-admin-api-key": "secret-key" }))).toBe(true);
    expect(
      await pred(null, ctx({ authorization: "Bearer secret-key" }))
    ).toBe(true);
    expect(await pred(null, ctx({ "x-admin-api-key": "wrong" }))).toBe(false);
  });

  it("denies when no identity rule is configured (apiKey absent, prod)", async () => {
    const pred = createAdminBypassPredicate({
      mode: "production",
      auth: { useSessionAuth: true },
    });
    expect(await pred(userWith({ roles: ["admin"] }), ctx())).toBe(false);
  });

  it("allows in development when the admin UI is fully open", async () => {
    const pred = createAdminBypassPredicate({ mode: "development" });
    expect(await pred(null, ctx())).toBe(true);
  });
});
