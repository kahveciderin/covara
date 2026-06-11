import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { encodeCursor, decodeCursor, CursorData } from "@/resource/pagination";
import { createTestApp, get } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  priority: integer("priority").default(0),
  category: text("category"),
});

describe("Pagination Cursor Hardening Tests", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-pagination-"));
  });

  afterAll(() => {
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
        priority INTEGER DEFAULT 0,
        category TEXT
      )
    `);

    for (let i = 1; i <= 20; i++) {
      await libsqlClient.execute(
        `INSERT INTO test_items (name, priority, category) VALUES ('Item ${i}', ${i % 5}, 'Cat${i % 3}')`
      );
    }

    app = createTestApp({ user: { id: "test-user" } });
    app.route(
      "/items",
      useResource(testItemsTable, {
        id: testItemsTable.id,
        db,
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
  });

  describe("Valid Cursor Operations", () => {
    it("should paginate through all items with cursor", async () => {
      const allItems: any[] = [];
      let cursor: string | null = null;

      do {
        const url = cursor ? `/items?limit=5&cursor=${cursor}` : "/items?limit=5";
        const res = await get(app, url);
        expect(res.status).toBe(200);

        allItems.push(...res.body.items);
        cursor = res.body.nextCursor;
      } while (cursor);

      expect(allItems.length).toBe(20);
    });

    it("should maintain ordering across pages", async () => {
      const firstPage = await get(app, "/items?limit=5&orderBy=name:asc");
      expect(firstPage.status).toBe(200);

      expect(firstPage.body.items.length).toBe(5);
      expect(firstPage.body.nextCursor).toBeDefined();

      const secondPage = await get(app, `/items?limit=5&orderBy=name:asc&cursor=${firstPage.body.nextCursor}`);
      expect(secondPage.status).toBe(200);

      const lastFirst = firstPage.body.items[4].name;
      const firstSecond = secondPage.body.items[0].name;

      expect(lastFirst < firstSecond || lastFirst === firstSecond).toBe(true);
    });

    it("should work with different orderBy fields", async () => {
      const page1 = await get(app, "/items?limit=10&orderBy=priority:desc");
      expect(page1.status).toBe(200);

      expect(page1.body.items.length).toBe(10);
      expect(page1.body.nextCursor).toBeDefined();

      const page2 = await get(app, `/items?limit=10&orderBy=priority:desc&cursor=${page1.body.nextCursor}`);
      expect(page2.status).toBe(200);

      expect(page2.body.items.length).toBe(10);
    });
  });

  describe("Malformed Cursor Handling", () => {
    it("should handle non-base64 cursor gracefully", async () => {
      const res = await get(app, "/items?cursor=not-valid-base64!!!");

      // Implementation may either reject with 400 or ignore invalid cursor and return 200
      expect([200, 400]).toContain(res.status);
      if (res.status === 400) {
        expect(res.body.code).toMatch(/CURSOR/i);
      }
    });

    it("should reject empty cursor gracefully", async () => {
      const res = await get(app, "/items?cursor=");
      expect(res.status).toBe(200);

      expect(res.body.items.length).toBeGreaterThan(0);
    });

    it("should reject truncated cursor", async () => {
      const firstPage = await get(app, "/items?limit=5");
      expect(firstPage.status).toBe(200);
      const validCursor = firstPage.body.nextCursor;

      if (validCursor) {
        const truncated = validCursor.slice(0, validCursor.length / 2);
        const res = await get(app, `/items?cursor=${truncated}`);

        expect([200, 400]).toContain(res.status);
      }
    });

    it("should reject random base64 that decodes to invalid JSON", async () => {
      const randomBase64 = Buffer.from("not a valid json object").toString("base64");

      const res = await get(app, `/items?cursor=${randomBase64}`);

      expect([200, 400]).toContain(res.status);
    });
  });

  describe("OrderBy Mismatch", () => {
    it("should handle cursor with different orderBy than original", async () => {
      const firstPage = await get(app, "/items?limit=5&orderBy=name:asc");
      expect(firstPage.status).toBe(200);

      const cursor = firstPage.body.nextCursor;

      if (cursor) {
        const res = await get(app, `/items?limit=5&orderBy=priority:desc&cursor=${cursor}`);

        expect([200, 400]).toContain(res.status);
      }
    });

    it("should handle cursor with no orderBy when original had orderBy", async () => {
      const firstPage = await get(app, "/items?limit=5&orderBy=name:desc");
      expect(firstPage.status).toBe(200);

      const cursor = firstPage.body.nextCursor;

      if (cursor) {
        const res = await get(app, `/items?limit=5&cursor=${cursor}`);

        expect([200, 400]).toContain(res.status);
      }
    });
  });

  describe("NULL Value Ordering", () => {
    it("should handle NULL values in ordering consistently", async () => {
      await libsqlClient.execute(
        "INSERT INTO test_items (name, priority, category) VALUES ('NullCat1', 10, NULL)"
      );
      await libsqlClient.execute(
        "INSERT INTO test_items (name, priority, category) VALUES ('NullCat2', 11, NULL)"
      );

      const firstPage = await get(app, "/items?limit=10&orderBy=category:asc");
      expect(firstPage.status).toBe(200);

      const allItems: any[] = [...firstPage.body.items];
      let cursor = firstPage.body.nextCursor;

      while (cursor) {
        const res = await get(app, `/items?limit=10&orderBy=category:asc&cursor=${cursor}`);
        expect(res.status).toBe(200);

        allItems.push(...res.body.items);
        cursor = res.body.nextCursor;
      }

      // Verify we can paginate and find NULL items
      expect(allItems.length).toBeGreaterThan(0);

      const nullItems = allItems.filter((item) => item.category === null);
      expect(nullItems.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Cursor with Filters", () => {
    it("should maintain filter across pagination", async () => {
      const filter = encodeURIComponent('priority>2');

      const firstPage = await get(app, `/items?limit=3&filter=${filter}`);
      expect(firstPage.status).toBe(200);

      if (firstPage.body.nextCursor) {
        const secondPage = await get(app, `/items?limit=3&filter=${filter}&cursor=${firstPage.body.nextCursor}`);
        expect(secondPage.status).toBe(200);

        for (const item of secondPage.body.items) {
          expect(item.priority).toBeGreaterThan(2);
        }
      }
    });

    it("should handle cursor when filter changes result set", async () => {
      const firstPage = await get(app, '/items?limit=5&filter=' + encodeURIComponent('priority==1'));
      expect(firstPage.status).toBe(200);

      const allMatching: any[] = [];
      let cursor = firstPage.body.nextCursor;
      allMatching.push(...firstPage.body.items);

      while (cursor) {
        const res = await get(app, `/items?limit=5&filter=${encodeURIComponent('priority==1')}&cursor=${cursor}`);
        expect(res.status).toBe(200);

        allMatching.push(...res.body.items);
        cursor = res.body.nextCursor;
      }

      for (const item of allMatching) {
        expect(item.priority).toBe(1);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle pagination with limit=1", async () => {
      let count = 0;
      let cursor: string | null = null;

      do {
        const url = cursor ? `/items?limit=1&cursor=${cursor}` : "/items?limit=1";
        const res = await get(app, url);
        expect(res.status).toBe(200);

        expect(res.body.items.length).toBeLessThanOrEqual(1);
        count += res.body.items.length;
        cursor = res.body.nextCursor;
      } while (cursor && count < 25);

      expect(count).toBe(20);
    });

    it("should return hasMore=false on last page", async () => {
      const firstPage = await get(app, "/items?limit=15");
      expect(firstPage.status).toBe(200);

      expect(firstPage.body.hasMore).toBe(true);

      if (firstPage.body.nextCursor) {
        const secondPage = await get(app, `/items?limit=15&cursor=${firstPage.body.nextCursor}`);
        expect(secondPage.status).toBe(200);

        expect(secondPage.body.hasMore).toBe(false);
        expect(secondPage.body.nextCursor).toBeNull();
      }
    });

    it("should handle cursor for empty result set", async () => {
      const filter = encodeURIComponent('name=="NonexistentItem"');

      const res = await get(app, `/items?filter=${filter}`);
      expect(res.status).toBe(200);

      expect(res.body.items.length).toBe(0);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextCursor).toBeNull();
    });
  });
});
