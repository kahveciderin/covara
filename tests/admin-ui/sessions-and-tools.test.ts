import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createAdminUI, AdminUIConfig } from "../../src/ui/middleware";
import {
  registerResourceSchema,
  setResourceMountPath,
  clearSchemaRegistry,
} from "../../src/ui/schema-registry";
import { get, post } from "../helpers/hono";

const form = (
  app: Hono,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {}
) =>
  app
    .request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    })
    .then(async (res) => ({ status: res.status, body: await res.text() }));

describe("Admin UI sessions", () => {
  let app: Hono;

  // A session manager that returns the legacy alias shape (sessionToken/expires)
  // to prove the admin UI normalizes whatever the store hands back.
  const aliasSessions = [
    {
      sessionToken: "sess-token-aaaaaaaaaaaaaaaaaa",
      userId: "user-bbbbbbbbbbbb",
      expires: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    },
  ];

  const config: AdminUIConfig = {
    security: { mode: "development", auth: { disabled: true } },
    sessionManager: {
      listSessions: async () => aliasSessions,
      getSessionsByUser: async (userId) =>
        aliasSessions.filter((s) => s.userId === userId),
      createSession: async (userId, expiresIn) => ({
        token: `minted-${userId}-${expiresIn ?? "default"}`,
        expiresAt: new Date(Date.now() + 86400000),
      }),
      revokeSession: async () => {},
      revokeAllUserSessions: async () => 0,
    },
    userManager: {
      listUsers: async () => ({
        users: [{ id: "user-bbbbbbbbbbbb", email: "b@test.com" }],
        total: 1,
      }),
      getUser: async (id) => ({ id, email: "b@test.com", name: "B" }),
      createUser: async (data) => ({ id: "new", ...data }),
      updateUser: async (id, data) => ({ id, ...data }),
      deleteUser: async () => {},
    },
  };

  beforeEach(() => {
    app = new Hono();
    app.route("/__covara", createAdminUI(config));
  });

  it("renders the sessions list without crashing on alias field names", async () => {
    const res = await get(app, "/__covara/ui/sessions/list");
    expect(res.status).toBe(200);
    expect(res.body).toContain("sess-token-aaaaa");
    expect(res.body).not.toContain("undefined");
  });

  it("renders the full sessions page for alias-shaped sessions", async () => {
    const res = await get(app, "/__covara/ui/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Sessions");
    expect(res.body).toContain("sess-token-aaaaa");
  });

  it("renders a user's sessions in the user detail without crashing", async () => {
    const res = await get(app, "/__covara/ui/users/user-bbbbbbbbbbbb");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Active Sessions");
    expect(res.body).toContain("sess-token-aaaaa");
  });

  it("normalizes alias fields in the JSON sessions API", async () => {
    const res = await get(app, "/__covara/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].id).toBe("sess-token-aaaaaaaaaaaaaaaaaa");
    expect(typeof res.body.sessions[0].expiresAt).toBe("string");
  });

  it("mints a session from an HTMX form (urlencoded) and returns the list", async () => {
    const res = await form(
      app,
      "/__covara/api/sessions",
      { userId: "user-bbbbbbbbbbbb", expiresIn: "3600" },
      { "hx-request": "true" }
    );
    expect(res.status).toBe(200);
    // HTMX response is the refreshed sessions list HTML, not JSON.
    expect(res.body).toContain("Active Sessions");
  });

  it("mints a session from a JSON request and returns the session", async () => {
    const res = await post(app, "/__covara/api/sessions", {
      userId: "user-bbbbbbbbbbbb",
      expiresIn: 3600,
    });
    expect(res.status).toBe(201);
    expect(res.body.session.token).toContain("minted-user-bbbbbbbbbbbb");
  });

  it("rejects a form mint without a userId", async () => {
    const res = await form(
      app,
      "/__covara/api/sessions",
      { expiresIn: "3600" },
      { "hx-request": "true" }
    );
    expect(res.body).toContain("userId is required");
  });

  it("creates a user from an HTMX form (urlencoded)", async () => {
    const res = await form(
      app,
      "/__covara/api/users",
      { email: "new@test.com", name: "New" },
      { "hx-request": "true" }
    );
    expect(res.status).toBe(201);
    expect(res.body).toContain("new@test.com");
  });
});

const items = sqliteTable("filter_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status"),
  count: integer("count"),
});

describe("Admin UI filter tester + API explorer", () => {
  let app: Hono;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE filter_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT,
        count INTEGER
      )
    `);
    sqlite.exec(`
      INSERT INTO filter_items (id, name, status, count) VALUES
        ('1', 'Alpha', 'active', 10),
        ('2', 'Beta', 'inactive', 20),
        ('3', 'Gamma', 'active', 30)
    `);
    clearSchemaRegistry();
    registerResourceSchema("filter_items", items, db, items.id, {
      capabilities: {
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
    });
    setResourceMountPath("filter_items", "/api/filter_items");

    app = new Hono();
    app.route("/__covara", createAdminUI({ security: { mode: "development", auth: { disabled: true } } }));
  });

  afterEach(() => {
    sqlite.close();
    clearSchemaRegistry();
  });

  it("runs an RSQL filter against live data", async () => {
    const res = await form(app, "/__covara/ui/filter/test", {
      resource: "filter_items",
      filter: 'status=="active"',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("2/3 matched");
  });

  it("reports a parse error for an invalid filter", async () => {
    const res = await form(app, "/__covara/ui/filter/test", {
      resource: "filter_items",
      filter: "this is not valid !!!",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Filter Error");
  });

  it("errors clearly for an unknown resource", async () => {
    const res = await form(app, "/__covara/ui/filter/test", {
      resource: "does_not_exist",
      filter: 'status=="active"',
    });
    expect(res.body).toContain("Unknown resource");
  });

  it("includes the captured mount path in the API explorer endpoints", async () => {
    const res = await get(app, "/__covara/ui/api-explorer/endpoint/0");
    expect(res.status).toBe(200);
    expect(res.body).toContain("/api/filter_items");
  });

  it("registers the execute route and renders a response card on failure", async () => {
    // fetch() targets the (non-listening) origin in tests, so this exercises
    // the error path — the important guarantee is the route is no longer a 404.
    const res = await form(app, "/__covara/ui/api-explorer/execute", {
      method: "GET",
      path: "/api/filter_items",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Response");
  });
});
