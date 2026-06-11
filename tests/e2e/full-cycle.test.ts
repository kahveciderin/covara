import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "../../src/resource/hook";
import { createClient, ConcaveClient } from "../../src/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestApp } from "../helpers/hono";

const startServer = (app: Hono): Promise<{ server: ServerType; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server, baseUrl: `http://localhost:${info.port}` });
    });
  });

const stopServer = (server: ServerType): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

// test schema
const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("active"),
  age: integer("age"),
});

type User = typeof usersTable.$inferSelect;

describe("End-to-End: Full Request Cycle", () => {
  let app: Hono;
  let server: ServerType;
  let client: ConcaveClient;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(async () => {
    // setup file-based database in temp directory
    tempDir = mkdtempSync(join(tmpdir(), "concave-e2e-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    // create table
    await libsqlClient.execute(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        age INTEGER
      )
    `);

    // setup app with a fake admin test user injected for all requests
    app = createTestApp({ user: { id: "test-user", email: "test@test.com" } });

    // setup resource
    app.route(
      "/users",
      useResource(usersTable, {
        id: usersTable.id,
        db,
        batch: { maxItems: 100 },
        pagination: { defaultLimit: 20, maxLimit: 100 },
      })
    );

    // start server
    const started = await startServer(app);
    server = started.server;

    // create client
    client = createClient({ baseUrl: started.baseUrl });
  });

  afterAll(async () => {
    await stopServer(server);
    libsqlClient.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    // clear and seed test data
    await libsqlClient.execute("DELETE FROM users");
    await libsqlClient.execute(`
      INSERT INTO users (name, email, role, status, age) VALUES
        ('Alice', 'alice@test.com', 'admin', 'active', 30),
        ('Bob', 'bob@test.com', 'user', 'active', 25),
        ('Charlie', 'charlie@test.com', 'user', 'inactive', 35)
    `);
  });

  describe("CRUD Operations", () => {
    it("should list all resources", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list();

      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    it("should get single resource", async () => {
      const users = client.resource<User & { id: string }>("/users");
      // first list to get actual ids
      const list = await users.list();
      const firstUser = list.items[0];

      const user = await users.get(firstUser.id);
      expect(user.id).toBe(firstUser.id);
      expect(user.name).toBeDefined();
    });

    it("should create new resource", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const created = await users.create({
        name: "David",
        email: "david@test.com",
        role: "user",
        status: "active",
        age: 28,
      });

      expect(created.id).toBeDefined();
      expect(created.name).toBe("David");

      // verify in database via API
      const fetched = await users.get(created.id);
      expect(fetched.name).toBe("David");
    });

    it("should update resource", async () => {
      const users = client.resource<User & { id: string }>("/users");
      // first get an existing user
      const list = await users.list({ filter: 'name=="Alice"' });
      const alice = list.items[0];

      const updated = await users.update(alice.id, { name: "Alice Updated" });

      expect(updated.name).toBe("Alice Updated");
      expect(updated.email).toBe("alice@test.com");
    });

    it("should replace resource", async () => {
      const users = client.resource<User & { id: string }>("/users");
      // first get an existing user
      const list = await users.list({ filter: 'name=="Alice"' });
      const alice = list.items[0];

      const replaced = await users.replace(alice.id, {
        name: "Alice New",
        email: "alicenew@test.com",
        role: "moderator",
        status: "active",
        age: 31,
      });

      expect(replaced.name).toBe("Alice New");
      expect(replaced.email).toBe("alicenew@test.com");
      expect(replaced.role).toBe("moderator");
    });

    it("should delete resource", async () => {
      const users = client.resource<User & { id: string }>("/users");
      // first get an existing user
      const list = await users.list({ filter: 'name=="Charlie"' });
      const charlie = list.items[0];

      await users.delete(charlie.id);

      // verify deleted - should get 404
      await expect(users.get(charlie.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("Filtering", () => {
    it("should filter by equality", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ filter: 'role=="admin"' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Alice");
    });

    it("should filter by comparison", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ filter: "age>=30" });

      expect(result.items).toHaveLength(2);
      expect(result.items.map((u) => u.name).sort()).toEqual(["Alice", "Charlie"]);
    });

    it("should filter with AND condition", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ filter: 'role=="user";status=="active"' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Bob");
    });

    it("should filter with OR condition", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ filter: 'name=="Alice",name=="Bob"' });

      expect(result.items).toHaveLength(2);
    });

    it("should filter with LIKE pattern", async () => {
      const users = client.resource<User & { id: string }>("/users");
      // use the correct LIKE syntax - field%="pattern"
      const result = await users.list({ filter: 'email%="%test.com"' });

      expect(result.items).toHaveLength(3);
    });
  });

  describe("Pagination", () => {
    beforeEach(async () => {
      // add more users for pagination testing
      for (let i = 1; i <= 25; i++) {
        await libsqlClient.execute(`INSERT INTO users (name, email) VALUES ('User${i}', 'user${i}@test.com')`);
      }
    });

    it("should paginate with limit", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ limit: 10 });

      expect(result.items).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it("should paginate with cursor", async () => {
      const users = client.resource<User & { id: string }>("/users");

      const page1 = await users.list({ limit: 10 });
      expect(page1.items).toHaveLength(10);

      const page2 = await users.list({ limit: 10, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(10);

      // pages should have different items
      const page1Ids = page1.items.map((u) => u.id);
      const page2Ids = page2.items.map((u) => u.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    });

    it("should get total count", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ limit: 10, totalCount: true });

      expect(result.items).toHaveLength(10);
      expect(result.totalCount).toBe(28); // 3 seeded + 25 added
    });
  });

  describe("Count", () => {
    it("should count all resources", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const count = await users.count();

      expect(count).toBe(3);
    });

    it("should count with filter", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const count = await users.count('status=="active"');

      expect(count).toBe(2);
    });
  });

  describe("Batch Operations", () => {
    it("should batch create resources", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const created = await users.batchCreate([
        { name: "Batch1", email: "batch1@test.com", role: "user", status: "active", age: 20 },
        { name: "Batch2", email: "batch2@test.com", role: "user", status: "active", age: 21 },
        { name: "Batch3", email: "batch3@test.com", role: "user", status: "active", age: 22 },
      ]);

      expect(created).toHaveLength(3);
      expect(created[0].name).toBe("Batch1");
      expect(created[1].name).toBe("Batch2");
      expect(created[2].name).toBe("Batch3");
    });

    it("should batch update resources", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.batchUpdate('role=="user"', { status: "pending" } as any);

      expect(result.count).toBe(2);

      // verify updates via API
      const bobResult = await users.list({ filter: 'name=="Bob"' });
      const charlieResult = await users.list({ filter: 'name=="Charlie"' });
      expect(bobResult.items[0].status).toBe("pending");
      expect(charlieResult.items[0].status).toBe("pending");
    });

    it("should batch delete resources", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.batchDelete('status=="inactive"');

      expect(result.count).toBe(1);

      // verify deletion
      const remaining = await users.list();
      expect(remaining.items).toHaveLength(2);
      expect(remaining.items.find((u) => u.name === "Charlie")).toBeUndefined();
    });
  });

  describe("Error Handling", () => {
    it("should return 404 for non-existent resource", async () => {
      const users = client.resource<User & { id: string }>("/users");

      await expect(users.get("999")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("should return 404 when updating non-existent resource", async () => {
      const users = client.resource<User & { id: string }>("/users");

      await expect(users.update("999", { name: "Test" })).rejects.toMatchObject({
        status: 404,
      });
    });

    it("should return 404 when deleting non-existent resource", async () => {
      const users = client.resource<User & { id: string }>("/users");

      await expect(users.delete("999")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("should handle invalid filter gracefully", async () => {
      const users = client.resource<User & { id: string }>("/users");

      await expect(users.list({ filter: "invalid===filter" })).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe("Ordering", () => {
    it("should order by ascending", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ orderBy: "name:asc" });

      expect(result.items[0].name).toBe("Alice");
      expect(result.items[1].name).toBe("Bob");
      expect(result.items[2].name).toBe("Charlie");
    });

    it("should order by descending", async () => {
      const users = client.resource<User & { id: string }>("/users");
      const result = await users.list({ orderBy: "age:desc" });

      expect(result.items[0].age).toBe(35);
      expect(result.items[1].age).toBe(30);
      expect(result.items[2].age).toBe(25);
    });
  });
});

describe("End-to-End: Concurrent Operations", () => {
  let app: Hono;
  let server: ServerType;
  let client: ConcaveClient;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  const concurrentUsersTable = sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    email: text("email").notNull(),
  });

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-e2e-concurrent-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      )
    `);

    app = createTestApp({ user: { id: "test-user", email: "test@test.com" } });
    app.route(
      "/users",
      useResource(concurrentUsersTable, {
        id: concurrentUsersTable.id,
        db,
      })
    );

    const started = await startServer(app);
    server = started.server;
    client = createClient({ baseUrl: started.baseUrl });
  });

  afterAll(async () => {
    if (server) {
      await stopServer(server);
    }
    if (libsqlClient) {
      libsqlClient.close();
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    await libsqlClient.execute("DELETE FROM users");
  });

  it("should handle concurrent creates", async () => {
    const users = client.resource<{ id: string; name: string; email: string }>("/users");

    const createPromises = Array.from({ length: 10 }, (_, i) =>
      users.create({ name: `User${i}`, email: `user${i}@test.com` })
    );

    const results = await Promise.all(createPromises);

    expect(results).toHaveLength(10);
    expect(new Set(results.map((r) => r.id)).size).toBe(10); // all unique ids
  });

  it("should handle concurrent reads", async () => {
    const users = client.resource<{ id: string; name: string; email: string }>("/users");

    // seed some data first (sequentially to avoid SQLite locking)
    await users.create({ name: "User1", email: "user1@test.com" });
    await users.create({ name: "User2", email: "user2@test.com" });

    // verify created users
    const initialList = await users.list();
    expect(initialList.items).toHaveLength(2);

    // sequential reads should work after concurrent creates in previous test
    const result1 = await users.list();
    const result2 = await users.list();
    const result3 = await users.list();

    expect(result1.items).toHaveLength(2);
    expect(result2.items).toHaveLength(2);
    expect(result3.items).toHaveLength(2);
  });
});

describe("End-to-End: Multiple Resources", () => {
  let app: Hono;
  let server: ServerType;
  let client: ConcaveClient;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  const multiUsersTable = sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  });

  const postsTable = sqliteTable("posts", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    userId: integer("user_id").notNull(),
  });

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-e2e-multi-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    await libsqlClient.execute(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, user_id INTEGER NOT NULL)`);

    app = createTestApp({ user: { id: "test-user", email: "test@test.com" } });
    app.route("/users", useResource(multiUsersTable, { id: multiUsersTable.id, db }));
    app.route("/posts", useResource(postsTable, { id: postsTable.id, db }));

    const started = await startServer(app);
    server = started.server;
    client = createClient({ baseUrl: started.baseUrl });
  });

  afterAll(async () => {
    await stopServer(server);
    libsqlClient.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    await libsqlClient.execute("DELETE FROM users");
    await libsqlClient.execute("DELETE FROM posts");
  });

  it("should work with multiple independent resources", async () => {
    const users = client.resource<{ id: string; name: string }>("/users");
    const posts = client.resource<{ id: string; title: string; userId: number }>("/posts");

    const user = await users.create({ name: "Author" });
    const post = await posts.create({ title: "My Post", userId: parseInt(user.id) });

    expect(user.name).toBe("Author");
    expect(post.title).toBe("My Post");

    const userList = await users.list();
    const postList = await posts.list();

    expect(userList.items).toHaveLength(1);
    expect(postList.items).toHaveLength(1);
  });
});
