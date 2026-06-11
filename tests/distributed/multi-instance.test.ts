import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createMemoryKV, setGlobalKV } from "@/kv";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  value: integer("value").notNull(),
});

const createTestServer = (db: any): Hono => {
  const app = createTestApp({ user: {} });
  app.route(
    "/items",
    useResource(testItemsTable, {
      id: testItemsTable.id,
      db,
    })
  );
  return app;
};

describe("Multi-Instance Distributed Tests", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let sharedKV: ReturnType<typeof createMemoryKV>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-distributed-"));
    sharedKV = createMemoryKV("shared");
    await sharedKV.connect();
    setGlobalKV(sharedKV);
  });

  afterAll(async () => {
    await sharedKV.disconnect();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_items`);
    await libsqlClient.execute(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    libsqlClient.close();
  });

  it("should share data between two instances using same database", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await post(instance1, "/items", { name: "SharedItem", value: 100 });
    expect(createRes.status).toBe(201);

    const itemId = createRes.body.id;

    const getRes = await get(instance2, `/items/${itemId}`);
    expect(getRes.status).toBe(200);

    expect(getRes.body.name).toBe("SharedItem");
    expect(getRes.body.value).toBe(100);
  });

  it("should see updates from one instance on another", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await post(instance1, "/items", { name: "ToUpdate", value: 50 });
    expect(createRes.status).toBe(201);

    const itemId = createRes.body.id;

    const patchRes = await patch(instance2, `/items/${itemId}`, { value: 150 });
    expect(patchRes.status).toBe(200);

    const getRes = await get(instance1, `/items/${itemId}`);
    expect(getRes.status).toBe(200);

    expect(getRes.body.value).toBe(150);
  });

  it("should see deletions from one instance on another", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await post(instance1, "/items", { name: "ToDelete", value: 200 });
    expect(createRes.status).toBe(201);

    const itemId = createRes.body.id;

    const deleteRes = await del(instance2, `/items/${itemId}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await get(instance1, `/items/${itemId}`);
    expect(getRes.status).toBe(404);
  });

  it("should maintain consistency with concurrent writes to different instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const items: number[] = [];

    const createPromises = [
      post(instance1, "/items", { name: "Item1", value: 1 }),
      post(instance2, "/items", { name: "Item2", value: 2 }),
      post(instance1, "/items", { name: "Item3", value: 3 }),
      post(instance2, "/items", { name: "Item4", value: 4 }),
    ];

    const results = await Promise.all(createPromises);

    for (const res of results) {
      expect(res.status).toBe(201);
      items.push(res.body.id);
    }

    const listRes1 = await get(instance1, "/items");
    expect(listRes1.status).toBe(200);
    const listRes2 = await get(instance2, "/items");
    expect(listRes2.status).toBe(200);

    expect(listRes1.body.items.length).toBe(4);
    expect(listRes2.body.items.length).toBe(4);
  });

  it("should handle filter queries consistently across instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    expect((await post(instance1, "/items", { name: "A", value: 10 })).status).toBe(201);
    expect((await post(instance2, "/items", { name: "B", value: 20 })).status).toBe(201);
    expect((await post(instance1, "/items", { name: "C", value: 30 })).status).toBe(201);

    const filter = encodeURIComponent("value>15");

    const filterRes1 = await get(instance1, `/items?filter=${filter}`);
    expect(filterRes1.status).toBe(200);
    const filterRes2 = await get(instance2, `/items?filter=${filter}`);
    expect(filterRes2.status).toBe(200);

    expect(filterRes1.body.items.length).toBe(2);
    expect(filterRes2.body.items.length).toBe(2);
  });

  it("should handle count queries consistently across instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    expect((await post(instance1, "/items", { name: "Count1", value: 5 })).status).toBe(201);
    expect((await post(instance2, "/items", { name: "Count2", value: 10 })).status).toBe(201);
    expect((await post(instance1, "/items", { name: "Count3", value: 15 })).status).toBe(201);

    const countRes1 = await get(instance1, "/items/count");
    expect(countRes1.status).toBe(200);
    const countRes2 = await get(instance2, "/items/count");
    expect(countRes2.status).toBe(200);

    expect(countRes1.body.count).toBe(3);
    expect(countRes2.body.count).toBe(3);
  });
});
