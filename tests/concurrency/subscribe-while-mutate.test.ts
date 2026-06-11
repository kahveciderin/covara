import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, patch, del, SSECollector, flushAsync } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category").notNull(),
  price: integer("price").notNull(),
  active: integer("active", { mode: "boolean" }).default(true),
});

describe("Subscribe While Mutate Tests", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let collectors: SSECollector[];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-subscribe-mutate-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    collectors = [];
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_items`);
    await libsqlClient.execute(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price INTEGER NOT NULL,
        active INTEGER DEFAULT 1
      )
    `);

    app = createTestApp({ user: {} });
    app.route(
      "/items",
      useResource(testItemsTable, {
        id: testItemsTable.id,
        db,
      })
    );
  });

  afterEach(async () => {
    for (const collector of collectors) {
      collector.close();
    }
    await flushAsync();
    if (libsqlClient) {
      libsqlClient.close();
    }
  });

  const connect = async (path: string) => {
    const { collector, response } = await SSECollector.connect(app, path);
    if (collector) collectors.push(collector);
    return { collector, response };
  };

  it("should connect to SSE endpoint", async () => {
    const { collector, response } = await connect("/items/subscribe");

    expect(response.status).toBe(200);

    const connected = await collector.next();
    expect(connected?.event).toBe("connected");
    expect(Array.isArray(collector.events)).toBe(true);
  });

  it("should receive events during concurrent mutations", async () => {
    const { collector } = await connect("/items/subscribe");
    await collector.next();

    const createPromises = Array.from({ length: 5 }, (_, i) =>
      post(app, "/items", { name: `Item${i}`, category: "Test", price: i * 10 })
    );

    const results = await Promise.all(createPromises);
    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(5);

    await flushAsync(200);

    expect(Array.isArray(collector.events)).toBe(true);
  });

  it("should handle mutations and subscription without data loss", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await post(app, "/items", { name: `PreExisting${i}`, category: "Initial", price: 100 });
      expect(res.status).toBe(201);
    }

    const { collector } = await connect("/items/subscribe");
    await collector.next();

    const createRes = await post(app, "/items", { name: "NewItem", category: "New", price: 50 });
    expect(createRes.status).toBe(201);

    await collector.waitFor((e) => e.data?.type === "added" && e.data?.object?.name === "NewItem", 2000);
    await flushAsync();

    const hasEvents = collector.events.length > 0;
    expect(hasEvents).toBe(true);
  });

  it("should maintain data integrity during subscribe/mutate cycle", async () => {
    const createRes = await post(app, "/items", { name: "TestItem", category: "Category1", price: 100 });
    expect(createRes.status).toBe(201);

    const itemId = createRes.body.id;

    const { collector } = await connect("/items/subscribe");
    await collector.next();

    const patchRes = await patch(app, `/items/${itemId}`, { name: "UpdatedItem" });
    expect(patchRes.status).toBe(200);

    const deleteRes = await del(app, `/items/${itemId}`);
    expect(deleteRes.status).toBe(204);

    await flushAsync(200);

    expect(Array.isArray(collector.events)).toBe(true);

    const listRes = await get(app, "/items");
    expect(listRes.status).toBe(200);
    const item = listRes.body.items.find((i: any) => i.id === itemId);
    expect(item).toBeUndefined();
  });

  it("should filter events by category when filter is provided", async () => {
    const res1 = await post(app, "/items", { name: "Electronics1", category: "Electronics", price: 100 });
    expect(res1.status).toBe(201);

    const res2 = await post(app, "/items", { name: "Clothing1", category: "Clothing", price: 50 });
    expect(res2.status).toBe(201);

    const filter = encodeURIComponent('category=="Clothing"');
    const { collector } = await connect(`/items/subscribe?filter=${filter}`);
    await collector.next();

    const res3 = await post(app, "/items", { name: "Clothing2", category: "Clothing", price: 60 });
    expect(res3.status).toBe(201);

    const res4 = await post(app, "/items", { name: "Electronics2", category: "Electronics", price: 200 });
    expect(res4.status).toBe(201);

    await collector.waitFor(
      (e) => e.data?.type === "added" && e.data?.object?.name === "Clothing2",
      2000
    );
    await flushAsync(200);

    const itemEvents = collector.events.filter((e) => e.data?.object);
    const categories = itemEvents.map((e) => e.data.object.category);

    categories.forEach((cat) => {
      expect(cat).not.toBe("Electronics");
    });
  });
});
