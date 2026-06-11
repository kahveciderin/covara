import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const testUsersTable = sqliteTable("test_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  version: integer("version").default(1),
});

describe("ETag Race Condition Tests", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-etag-race-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_users`);
    await libsqlClient.execute(`
      CREATE TABLE test_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        version INTEGER DEFAULT 1
      )
    `);

    app = createTestApp({ user: { id: "test-user" } });
    app.route(
      "/users",
      useResource(testUsersTable, {
        id: testUsersTable.id,
        db,
        etag: {
          versionField: "version",
        },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
  });

  it("should allow concurrent updates without If-Match", async () => {
    const createRes = await post(app, "/users", { name: "Alice", email: "alice@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;

    const [res1, res2] = await Promise.all([
      patch(app, `/users/${userId}`, { name: "Alice Updated 1" }),
      patch(app, `/users/${userId}`, { name: "Alice Updated 2" }),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 200]);
  });

  it("should handle concurrent updates", async () => {
    const createRes = await post(app, "/users", { name: "Bob", email: "bob@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;

    const update1 = patch(app, `/users/${userId}`, { name: "Bob Client1" });
    const update2 = patch(app, `/users/${userId}`, { name: "Bob Client2" });

    const [res1, res2] = await Promise.all([update1, update2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const getRes = await get(app, `/users/${userId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toMatch(/^Bob Client[12]$/);
  });

  it("should generate ETags for responses", async () => {
    const createRes = await post(app, "/users", { name: "Carol", email: "carol@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers.get("etag");

    expect(initialETag).toBeDefined();
    expect(initialETag).toMatch(/^(W\/)?"[^"]+"/);

    const getRes = await get(app, `/users/${userId}`);
    expect(getRes.status).toBe(200);

    expect(getRes.headers.get("etag")).toBeDefined();
  });

  it("should handle multiple concurrent clients with optimistic locking", async () => {
    const createRes = await post(app, "/users", { name: "Dave", email: "dave@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers.get("etag")!;

    const clients = Array.from({ length: 5 }, (_, i) =>
      patch(app, `/users/${userId}`, { name: `Dave Client${i}` }, { "If-Match": initialETag })
    );

    const results = await Promise.all(clients);

    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status === 412);

    expect(successes.length + failures.length).toBe(5);
    // Compare-and-swap guarantees exactly one writer wins when all present the
    // same If-Match; the rest must get 412 (no lost updates).
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);

    const finalGet = await get(app, `/users/${userId}`);
    expect(finalGet.body.version).toBe(2);
  });

  it("should handle delete operations", async () => {
    const createRes = await post(app, "/users", { name: "Eve", email: "eve@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;

    const updateRes = await patch(app, `/users/${userId}`, { name: "Eve Updated" });
    expect(updateRes.status).toBe(200);

    const getRes = await get(app, `/users/${userId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("Eve Updated");

    const deleteRes = await del(app, `/users/${userId}`);
    expect(deleteRes.status).toBe(204);

    const getAfterDelete = await get(app, `/users/${userId}`);
    expect(getAfterDelete.status).toBe(404);
  });

  it("should handle If-Match: * to match any ETag", async () => {
    const createRes = await post(app, "/users", { name: "Frank", email: "frank@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;

    const updateRes = await patch(
      app,
      `/users/${userId}`,
      { name: "Frank Star Match" },
      { "If-Match": "*" }
    );
    expect(updateRes.status).toBe(200);
  });

  it("should include new ETag in successful response", async () => {
    const createRes = await post(app, "/users", { name: "Grace", email: "grace@test.com" });
    expect(createRes.status).toBe(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers.get("etag")!;

    const updateRes = await patch(
      app,
      `/users/${userId}`,
      { name: "Grace Updated" },
      { "If-Match": initialETag }
    );
    expect(updateRes.status).toBe(200);

    const newETag = updateRes.headers.get("etag");
    expect(newETag).toBeDefined();
    expect(newETag).not.toBe(initialETag);
  });
});
