import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { createClient, CovaraClient } from "@/client";
import { createResourceFilter } from "@/resource/filter";
import { createTestApp } from "../helpers/hono";

// smoke tests validate that core functionality works at a basic level
// these should be fast and reliable

const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

describe("Smoke Tests: Core Framework", () => {
  let app: Hono;
  let server: ServerType;
  let client: CovaraClient;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      )
    `);

    app = createTestApp({ user: { id: "test-user", email: "test@test.com" } });
    app.route("/users", useResource(usersTable, { id: usersTable.id, db }));

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        client = createClient({ baseUrl: `http://localhost:${info.port}` });
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    libsqlClient.close();
  });

  beforeEach(async () => {
    await libsqlClient.execute("DELETE FROM users");
    await libsqlClient.execute(`
      INSERT INTO users (name, email) VALUES
        ('Alice', 'alice@test.com'),
        ('Bob', 'bob@test.com')
    `);
  });

  describe("Critical Path: REST API", () => {
    it("SMOKE: Server responds to requests", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const result = await users.list();
      expect(result).toBeDefined();
      expect(result.items).toBeDefined();
    });

    it("SMOKE: Can create a resource", async () => {
      const users = client.resource<{ id: string; name: string; email: string }>("/users");
      const created = await users.create({ name: "Test", email: "test@test.com" });
      expect(created.id).toBeDefined();
    });

    it("SMOKE: Can read a resource", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const list = await users.list();
      const user = await users.get(list.items[0].id);
      expect(user).toBeDefined();
    });

    it("SMOKE: Can update a resource", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const list = await users.list();
      const updated = await users.update(list.items[0].id, { name: "Updated" });
      expect(updated.name).toBe("Updated");
    });

    it("SMOKE: Can delete a resource", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const list = await users.list();
      const countBefore = list.items.length;
      await users.delete(list.items[0].id);
      const listAfter = await users.list();
      expect(listAfter.items.length).toBe(countBefore - 1);
    });
  });

  describe("Critical Path: Filtering", () => {
    it("SMOKE: Filter by equality works", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const result = await users.list({ filter: 'name=="Alice"' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Alice");
    });

    it("SMOKE: Filter by comparison works", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const result = await users.list({ filter: "id>=1" });
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  describe("Critical Path: Pagination", () => {
    it("SMOKE: Pagination returns results", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const result = await users.list({ limit: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(true);
    });

    it("SMOKE: Cursor pagination works", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const page1 = await users.list({ limit: 1 });
      expect(page1.nextCursor).toBeDefined();

      const page2 = await users.list({ limit: 1, cursor: page1.nextCursor! });
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });

  describe("Critical Path: Count", () => {
    it("SMOKE: Count returns correct total", async () => {
      const users = client.resource<{ id: string; name: string }>("/users");
      const count = await users.count();
      expect(count).toBe(2);
    });
  });

  describe("Critical Path: Batch Operations", () => {
    it("SMOKE: Batch create works", async () => {
      const users = client.resource<{ id: string; name: string; email: string }>("/users");
      const created = await users.batchCreate([
        { name: "Batch1", email: "batch1@test.com" },
        { name: "Batch2", email: "batch2@test.com" },
      ]);
      expect(created).toHaveLength(2);
    });
  });
});

describe("Smoke Tests: Client Library", () => {
  it("SMOKE: Client can be created", () => {
    const client = createClient({ baseUrl: "http://localhost:3000" });
    expect(client).toBeDefined();
    expect(client.transport).toBeDefined();
    expect(typeof client.resource).toBe("function");
  });

  it("SMOKE: Client can set auth token", () => {
    const client = createClient({ baseUrl: "http://localhost:3000" });
    client.setAuthToken("test-token");
    client.clearAuthToken();
    // should not throw
    expect(true).toBe(true);
  });

  it("SMOKE: Resource client has all methods", () => {
    const client = createClient({ baseUrl: "http://localhost:3000" });
    const resource = client.resource<{ id: string }>("/test");

    expect(typeof resource.list).toBe("function");
    expect(typeof resource.get).toBe("function");
    expect(typeof resource.create).toBe("function");
    expect(typeof resource.update).toBe("function");
    expect(typeof resource.replace).toBe("function");
    expect(typeof resource.delete).toBe("function");
    expect(typeof resource.count).toBe("function");
    expect(typeof resource.batchCreate).toBe("function");
    expect(typeof resource.batchUpdate).toBe("function");
    expect(typeof resource.batchDelete).toBe("function");
    expect(typeof resource.subscribe).toBe("function");
  });
});

describe("Smoke Tests: Filter System", () => {
  const testTable = sqliteTable("test", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    value: integer("value").notNull(),
  });

  it("SMOKE: Filter can be created", () => {
    const filter = createResourceFilter(testTable);
    expect(filter).toBeDefined();
    expect(typeof filter.convert).toBe("function");
    expect(typeof filter.execute).toBe("function");
  });

  it("SMOKE: Filter can parse basic expression", () => {
    const filter = createResourceFilter(testTable);
    const sql = filter.convert('name=="test"');
    expect(sql).toBeDefined();
  });

  it("SMOKE: Filter can execute basic expression", () => {
    const filter = createResourceFilter(testTable);
    const result = filter.execute('name=="test"', { id: 1, name: "test", value: 1 });
    expect(result).toBe(true);
  });
});

describe("Smoke Tests: Transport", () => {
  it("SMOKE: TransportError has correct properties", async () => {
    const { TransportError } = await import("../../src/client/transport");
    const error = new TransportError("Not found", 404, "NOT_FOUND", {});

    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.isNotFound()).toBe(true);
    expect(error.isUnauthorized()).toBe(false);
  });
});

describe("Smoke Tests: Offline Support", () => {
  it("SMOKE: InMemoryOfflineStorage works", async () => {
    const { InMemoryOfflineStorage } = await import("../../src/client/offline");
    const storage = new InMemoryOfflineStorage();

    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/test",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    const mutations = await storage.getMutations();
    expect(mutations).toHaveLength(1);

    await storage.clear();
    const cleared = await storage.getMutations();
    expect(cleared).toHaveLength(0);
  });

  it("SMOKE: OfflineManager can be created", async () => {
    const { createOfflineManager, InMemoryOfflineStorage } = await import("../../src/client/offline");
    const manager = createOfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    expect(manager).toBeDefined();
    expect(typeof manager.queueMutation).toBe("function");
  });
});

describe("Smoke Tests: Auth System", () => {
  it("SMOKE: ScopeResolver can be created", async () => {
    const { createScopeResolver } = await import("../../src/auth/scope");
    const resolver = createScopeResolver({}, "test");
    expect(resolver).toBeDefined();
  });

  it("SMOKE: RSQL builder functions work", async () => {
    const { eq, and, or, allScope, emptyScope } = await import("../../src/auth/rsql");

    const scope1 = eq("userId", "123");
    expect(scope1.toString()).toBe('userId=="123"');

    const scope2 = and(eq("a", 1), eq("b", 2));
    expect(scope2.toString()).toContain(";");

    const scope3 = or(eq("a", 1), eq("b", 2));
    expect(scope3.toString()).toContain(",");

    expect(allScope().toString()).toBe("*");
    expect(emptyScope().isEmpty()).toBe(true);
  });
});
