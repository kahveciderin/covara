import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createAdminUI } from "../../src/ui";
import {
  registerResourceSchema,
  clearSchemaRegistry,
} from "../../src/ui/schema-registry";
import { rsql, emptyScope } from "../../src/auth/rsql";
import { get } from "../helpers/hono";

const docsTable = sqliteTable("scope_docs", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
});

const USERS: Record<string, any> = {
  u1: { id: "u1", email: "u1@test.com", metadata: { roles: ["member"] } },
};

const userManager = {
  listUsers: async () => ({ users: Object.values(USERS), total: Object.keys(USERS).length }),
  getUser: async (id: string) => USERS[id] ?? null,
  createUser: async () => null,
  updateUser: async () => null,
  deleteUser: async () => {},
} as any;

describe("Impersonation scope-preview endpoint", () => {
  let app: Hono;
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`CREATE TABLE scope_docs (id TEXT PRIMARY KEY, userId TEXT NOT NULL)`);
    clearSchemaRegistry();

    registerResourceSchema("scope_docs", docsTable, db, docsTable.id, {
      auth: {
        read: async (u: any) => rsql`userId==${u.id}`,
        create: async () => emptyScope(),
      },
    });
    registerResourceSchema("public_docs", docsTable, db, docsTable.id, {
      auth: { public: { read: true } },
    });

    app = new Hono();
    app.route(
      "/__covara",
      createAdminUI({ security: { auth: { disabled: true }, mode: "development" }, userManager })
    );
  });

  afterEach(() => {
    sqlite.close();
    clearSchemaRegistry();
  });

  const preview = (q: string) =>
    get(app, `/__covara/api/impersonation/scope?${q}`);

  it("returns the owner scope filter for a read operation", async () => {
    const res = await preview("resource=scope_docs&operation=read&userId=u1");
    expect(res.status).toBe(200);
    expect(res.body.denied).toBe(false);
    expect(res.body.scope).toContain("userId");
    expect(res.body.scope).toContain("u1");
  });

  it("reports denied when the operation scope is empty for the user", async () => {
    const res = await preview("resource=scope_docs&operation=create&userId=u1");
    expect(res.status).toBe(200);
    expect(res.body.denied).toBe(true);
  });

  it("reports public access as a wildcard scope", async () => {
    const res = await preview("resource=public_docs&operation=read&userId=u1");
    expect(res.status).toBe(200);
    expect(res.body.public).toBe(true);
    expect(res.body.scope).toBe("*");
  });

  it("404s for an unknown resource", async () => {
    const res = await preview("resource=nope&operation=read&userId=u1");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown user", async () => {
    const res = await preview("resource=scope_docs&operation=read&userId=ghost");
    expect(res.status).toBe(404);
  });

  it("400s for an invalid operation", async () => {
    const res = await preview("resource=scope_docs&operation=frobnicate&userId=u1");
    expect(res.status).toBe(400);
  });
});
