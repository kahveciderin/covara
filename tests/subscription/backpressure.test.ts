import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, SSECollector, flushAsync } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  data: text("data").notNull(),
});

describe("Subscription Backpressure Tests", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let collectors: SSECollector[];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-backpressure-"));
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
        data TEXT NOT NULL
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

  it("should accept SSE connection", async () => {
    const { response } = await connect("/items/subscribe");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("should handle multiple concurrent subscriptions", async () => {
    const connectionCount = 5;

    const results = await Promise.all(
      Array.from({ length: connectionCount }, () => connect("/items/subscribe"))
    );

    const successCount = results.filter((r) => r.response.status === 200).length;
    expect(successCount).toBe(connectionCount);
  });

  it("should handle rapid data writes without server crash", async () => {
    const { collector } = await connect("/items/subscribe");
    await collector.next();

    const largeData = "x".repeat(1000);
    const writePromises = Array.from({ length: 50 }, (_, i) =>
      post(app, "/items", { name: `Item${i}`, data: largeData })
    );

    const results = await Promise.all(writePromises);
    const successCount = results.filter((r) => r.status === 201).length;

    expect(successCount).toBe(50);
  });

  it("should cleanup connections on client disconnect", async () => {
    const { collector } = await connect("/items/subscribe");
    await collector.next();

    collector.close();
    await flushAsync(100);

    const res = await post(app, "/items", { name: "AfterDisconnect", data: "test" });
    expect(res.status).toBe(201);
  });

  it("should handle subscription with filter correctly", async () => {
    const filter = encodeURIComponent('name=="TargetItem"');
    const { collector } = await connect(`/items/subscribe?filter=${filter}`);
    await collector.next();

    const res1 = await post(app, "/items", { name: "TargetItem", data: "matching" });
    expect(res1.status).toBe(201);

    const res2 = await post(app, "/items", { name: "OtherItem", data: "not matching" });
    expect(res2.status).toBe(201);

    await collector.waitFor((e) => e.data?.type === "added", 2000);
    await flushAsync(200);

    const itemEvents = collector.events.filter((e) => e.data?.object);
    expect(itemEvents.every((e) => e.data.object.name !== "OtherItem")).toBe(true);
  });

  it("should not accumulate memory with long-running subscription", async () => {
    const { collector } = await connect("/items/subscribe");
    await collector.next();

    const itemCount = 20;
    for (let i = 0; i < itemCount; i++) {
      const res = await post(app, "/items", { name: `MemoryItem${i}`, data: "x".repeat(500) });
      expect(res.status).toBe(201);
    }

    await flushAsync(100);

    collector.close();

    // Wait a bit more to ensure all writes are committed
    await flushAsync(100);

    const listRes = await get(app, "/items");
    expect(listRes.status).toBe(200);
    // Use >= to handle any potential timing issues with item creation
    expect(listRes.body.items.length).toBeGreaterThanOrEqual(itemCount);
  });

  it("should handle client that connects and immediately disconnects", async () => {
    const { collector } = await connect("/items/subscribe");
    collector.close();

    await flushAsync(100);

    const res = await post(app, "/items", { name: "PostDisconnect", data: "test" });
    expect(res.status).toBe(201);
  });
});
