import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import {
  setGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
} from "@/search";
import { createTestApp, get } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").default("active"),
});

describe("Search Endpoint", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let searchAdapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-search-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_items`);
    await libsqlClient.execute(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active'
      )
    `);

    searchAdapter = createMemorySearchAdapter();
    setGlobalSearch(searchAdapter);

    app = createTestApp({ user: {} });
  });

  afterEach(() => {
    libsqlClient.close();
    clearGlobalSearch();
  });

  describe("without search adapter", () => {
    beforeEach(() => {
      clearGlobalSearch();
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
        })
      );
    });

    it("should return 404 when search not configured", async () => {
      const res = await get(app, "/items/search?q=test");
      expect(res.status).toBe(404);
    });
  });

  describe("with search adapter", () => {
    beforeEach(async () => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
        })
      );

      await searchAdapter.index("test_items", "1", {
        id: 1,
        title: "Important Task",
        description: "Do this first",
        status: "active",
      });
      await searchAdapter.index("test_items", "2", {
        id: 2,
        title: "Normal Task",
        description: "Do this later",
        status: "active",
      });
      await searchAdapter.index("test_items", "3", {
        id: 3,
        title: "Another Important Item",
        description: "Critical",
        status: "completed",
      });
    });

    it("should return search results", async () => {
      const res = await get(app, "/items/search?q=important");
      expect(res.status).toBe(200);

      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should return 400 when query missing", async () => {
      const res = await get(app, "/items/search");
      expect(res.status).toBe(400);

      expect(res.body.detail).toBe("Missing query parameter 'q'");
    });

    it("should return empty results for no matches", async () => {
      const res = await get(app, "/items/search?q=nonexistent");
      expect(res.status).toBe(200);

      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    describe("pagination", () => {
      it("should respect limit parameter", async () => {
        const res = await get(app, "/items/search?q=task&limit=1");
        expect(res.status).toBe(200);

        expect(res.body.items).toHaveLength(1);
      });

      it("should respect offset parameter", async () => {
        const res1 = await get(app, "/items/search?q=task&limit=1&offset=0");
        expect(res1.status).toBe(200);

        const res2 = await get(app, "/items/search?q=task&limit=1&offset=1");
        expect(res2.status).toBe(200);

        expect(res1.body.items[0].id).not.toBe(res2.body.items[0].id);
      });

      it("should cap limit at 100", async () => {
        const res = await get(app, "/items/search?q=task&limit=200");
        expect(res.status).toBe(200);

        // Limit is capped internally, but we can't directly verify
        // The endpoint should not error
        expect(res.body).toHaveProperty("items");
      });
    });

    describe("RSQL filter", () => {
      it("should apply filter to search results", async () => {
        const res = await get(app, "/items/search?q=important&filter=status==completed");
        expect(res.status).toBe(200);

        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].status).toBe("completed");
      });

      it("should work with complex filters", async () => {
        const res = await get(app, "/items/search?q=task&filter=status==active");
        expect(res.status).toBe(200);

        for (const item of res.body.items) {
          expect(item.status).toBe("active");
        }
      });
    });

    describe("highlights", () => {
      it("should return highlights when requested", async () => {
        const res = await get(app, "/items/search?q=important&highlight=true");
        expect(res.status).toBe(200);

        expect(res.body.highlights).toBeDefined();
      });

      it("should not return highlights by default", async () => {
        const res = await get(app, "/items/search?q=important");
        expect(res.status).toBe(200);

        expect(res.body.highlights).toBeUndefined();
      });
    });
  });

  describe("with search disabled", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: false },
        })
      );
    });

    it("should return 404 when search disabled", async () => {
      const res = await get(app, "/items/search?q=test");
      expect(res.status).toBe(404);
    });
  });

  describe("custom index name", () => {
    beforeEach(async () => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: {
            enabled: true,
            indexName: "custom_index",
          },
        })
      );

      await searchAdapter.index("custom_index", "1", {
        id: 1,
        title: "Test Item",
      });
    });

    it("should use custom index name", async () => {
      const res = await get(app, "/items/search?q=test");
      expect(res.status).toBe(200);

      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("field configuration", () => {
    describe("array config", () => {
      beforeEach(async () => {
        app.route(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: ["title"],
            },
          })
        );

        await searchAdapter.index("test_items", "1", {
          id: 1,
          title: "Important",
          description: "Critical",
        });
      });

      it("should search only specified fields", async () => {
        const titleMatch = await get(app, "/items/search?q=important");
        expect(titleMatch.status).toBe(200);

        expect(titleMatch.body.items).toHaveLength(1);

        const descMatch = await get(app, "/items/search?q=critical");
        expect(descMatch.status).toBe(200);

        expect(descMatch.body.items).toHaveLength(0);
      });
    });

    describe("object config with weights", () => {
      beforeEach(async () => {
        app.route(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: {
                title: { weight: 2.0 },
                description: { weight: 1.0, searchable: true },
              },
            },
          })
        );

        await searchAdapter.index("test_items", "1", {
          id: 1,
          title: "Test",
          description: "Important",
        });
      });

      it("should respect searchable: false", async () => {
        const newApp = createTestApp({ user: {} });
        newApp.route(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: {
                title: { searchable: true },
                description: { searchable: false },
              },
            },
          })
        );

        await searchAdapter.index("test_items", "2", {
          id: 2,
          title: "Test",
          description: "UniqueDescription",
        });

        const res = await get(newApp, "/items/search?q=uniquedescription");
        expect(res.status).toBe(200);

        expect(res.body.items).toHaveLength(0);
      });
    });
  });
});
