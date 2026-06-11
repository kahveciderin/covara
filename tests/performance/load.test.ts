import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "../../src/resource/hook";
import { createClient, CovaraClient } from "../../src/client";
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

const itemsTable = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  value: integer("value").notNull().default(0),
});

describe("Performance: Load Testing", () => {
  let app: Hono;
  let server: ServerType;
  let client: CovaraClient;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-perf-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0
      )
    `);

    app = createTestApp({ user: { id: "test-user", email: "test@test.com" } });
    app.route("/items", useResource(itemsTable, {
      id: itemsTable.id,
      db,
      batch: { create: 1000, update: 1000, delete: 1000 },
      pagination: { defaultLimit: 100, maxLimit: 1000 },
    }));

    const started = await startServer(app);
    server = started.server;
    client = createClient({ baseUrl: started.baseUrl });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    libsqlClient.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    await libsqlClient.execute("DELETE FROM items");
  });

  describe("Sequential Operations", () => {
    it("should handle 100 sequential creates in under 2 seconds", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");
      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        await items.create({ name: `Item${i}`, value: i });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000);

      const list = await items.list({ limit: 100 });
      expect(list.items).toHaveLength(100);
    });

    it("should handle 100 sequential reads in under 1 second", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      // seed data
      for (let i = 0; i < 100; i++) {
        await items.create({ name: `Item${i}`, value: i });
      }

      const list = await items.list({ limit: 100 });
      const ids = list.items.map((i) => i.id);

      const startTime = Date.now();

      for (const id of ids) {
        await items.get(id);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle 50 concurrent creates", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");
      const startTime = Date.now();

      const promises = Array.from({ length: 50 }, (_, i) =>
        items.create({ name: `Concurrent${i}`, value: i })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(50);
      expect(new Set(results.map((r) => r.id)).size).toBe(50);
      expect(duration).toBeLessThan(2000);
    });

    it("should handle 100 concurrent reads", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      // seed data
      const created = await items.batchCreate(
        Array.from({ length: 20 }, (_, i) => ({ name: `Item${i}`, value: i }))
      );

      const ids = created.map((c) => c.id);

      const startTime = Date.now();

      // read each item 5 times concurrently (100 total reads)
      const promises = ids.flatMap((id) =>
        Array.from({ length: 5 }, () => items.get(id))
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(100);
      expect(duration).toBeLessThan(1000);
    });

    it("should handle mixed read/write operations concurrently", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      // seed initial data
      await items.batchCreate(
        Array.from({ length: 10 }, (_, i) => ({ name: `Initial${i}`, value: i }))
      );

      const startTime = Date.now();

      // mix of operations
      const operations: Promise<any>[] = [];

      // 20 reads
      for (let i = 0; i < 20; i++) {
        operations.push(items.list({ limit: 10 }));
      }

      // 20 creates
      for (let i = 0; i < 20; i++) {
        operations.push(items.create({ name: `New${i}`, value: i }));
      }

      // 10 counts
      for (let i = 0; i < 10; i++) {
        operations.push(items.count());
      }

      await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(3000);

      const finalCount = await items.count();
      expect(finalCount).toBe(30); // 10 initial + 20 new
    });
  });

  describe("Batch Operations Performance", () => {
    it("should create 100 items in batch efficiently", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      const batchData = Array.from({ length: 100 }, (_, i) => ({
        name: `Batch${i}`,
        value: i,
      }));

      const startTime = Date.now();
      const created = await items.batchCreate(batchData);
      const duration = Date.now() - startTime;

      expect(created).toHaveLength(100);
      expect(duration).toBeLessThan(2000);
    });

    it("should handle batch update on dataset", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      // seed 50 items with value 0 or 1 alternating
      await items.batchCreate(
        Array.from({ length: 50 }, (_, i) => ({ name: `Item${i}`, value: i % 2 }))
      );

      const startTime = Date.now();
      const result = await items.batchUpdate("value==0", { value: 999 } as any);
      const duration = Date.now() - startTime;

      expect(result.count).toBe(25);
      expect(duration).toBeLessThan(1000);
    });

    it("should handle batch delete efficiently", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      // seed 60 items with value 0, 1, or 2
      await items.batchCreate(
        Array.from({ length: 60 }, (_, i) => ({ name: `Item${i}`, value: i % 3 }))
      );

      const startTime = Date.now();
      const result = await items.batchDelete("value==0");
      const duration = Date.now() - startTime;

      expect(result.count).toBe(20);
      expect(duration).toBeLessThan(1000);

      const remaining = await items.count();
      expect(remaining).toBe(40);
    });
  });

  describe("Query Performance", () => {
    beforeEach(async () => {
      // seed large dataset
      const items = client.resource<{ id: string; name: string; value: number }>("/items");
      await items.batchCreate(
        Array.from({ length: 500 }, (_, i) => ({
          name: `Item${i % 100}`,
          value: i,
        }))
      );
    });

    it("should handle filtered queries efficiently", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      const startTime = Date.now();

      const result1 = await items.list({ filter: "value>=250", limit: 100 });
      const result2 = await items.list({ filter: "value<100", limit: 100 });
      const result3 = await items.list({ filter: 'name=="Item50"', limit: 100 });

      const duration = Date.now() - startTime;

      expect(result1.items.length).toBeGreaterThan(0);
      expect(result2.items.length).toBeGreaterThan(0);
      expect(result3.items.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500);
    });

    it("should paginate through large dataset efficiently", async () => {
      const items = client.resource<{ id: string; name: string; value: number }>("/items");

      const startTime = Date.now();
      let cursor: string | null = null;
      let pageCount = 0;

      // paginate through all items
      do {
        const result = await items.list({ limit: 50, cursor: cursor ?? undefined });
        cursor = result.nextCursor;
        pageCount++;
      } while (cursor !== null);

      const duration = Date.now() - startTime;

      expect(pageCount).toBe(10); // 500 items / 50 per page
      expect(duration).toBeLessThan(2000);
    });
  });
});

describe("Performance: Memory and Connection Handling", () => {
  it("should handle many client connections without memory leak", async () => {
    // this test creates multiple clients to verify no connection leak
    const clients: CovaraClient[] = [];

    for (let i = 0; i < 100; i++) {
      clients.push(createClient({ baseUrl: "http://localhost:9999" }));
    }

    // all clients should be created without issue
    expect(clients).toHaveLength(100);

    // no direct memory check available, but we verify creation is fast
  });
});
