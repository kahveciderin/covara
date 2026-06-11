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
import { createTestApp, post, patch, put, del } from "../helpers/hono";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
});

describe("Search Auto-Indexing", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let searchAdapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-autoindex-"));
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
        title TEXT NOT NULL,
        description TEXT
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

  describe("auto-indexing enabled (default)", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
        })
      );
    });

    it("should index documents on create", async () => {
      const res = await post(app, "/items", { title: "New Item", description: "Test description" });
      expect(res.status).toBe(201);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.has(String(res.body.id))).toBe(true);
    });

    it("should re-index documents on update (PATCH)", async () => {
      const createRes = await post(app, "/items", { title: "Original", description: "Test" });
      expect(createRes.status).toBe(201);

      const patchRes = await patch(app, `/items/${createRes.body.id}`, { title: "Updated" });
      expect(patchRes.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Updated");
    });

    it("should re-index documents on update (PUT)", async () => {
      const createRes = await post(app, "/items", { title: "Original", description: "Test" });
      expect(createRes.status).toBe(201);

      const putRes = await put(app, `/items/${createRes.body.id}`, { title: "Replaced", description: "New" });
      expect(putRes.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Replaced");
    });

    it("should remove documents from index on delete", async () => {
      const createRes = await post(app, "/items", { title: "To Delete" });
      expect(createRes.status).toBe(201);

      const id = String(createRes.body.id);
      expect(searchAdapter.getIndex("test_items")?.has(id)).toBe(true);

      const delRes = await del(app, `/items/${createRes.body.id}`);
      expect(delRes.status).toBe(204);

      expect(searchAdapter.getIndex("test_items")?.has(id)).toBe(false);
    });

    it("should index all created documents in batch create", async () => {
      app = createTestApp({ user: {} });
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { create: 10 },
        })
      );

      const res = await post(app, "/items/batch", {
        items: [
          { title: "Item 1" },
          { title: "Item 2" },
          { title: "Item 3" },
        ],
      });
      expect(res.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size).toBe(3);
    });

    it("should update all documents in batch update", async () => {
      const createRes = await post(app, "/items", { title: "To Update" });
      expect(createRes.status).toBe(201);

      app = createTestApp({ user: {} });
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { update: 10 },
        })
      );

      const updateRes = await patch(app, "/items/batch", { title: "Batch Updated" });
      expect(updateRes.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Batch Updated");
    });

    it("should remove all documents in batch delete", async () => {
      const res1 = await post(app, "/items", { title: "Delete 1" });
      expect(res1.status).toBe(201);
      const res2 = await post(app, "/items", { title: "Delete 2" });
      expect(res2.status).toBe(201);

      app = createTestApp({ user: {} });
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { delete: 10 },
        })
      );

      const delRes = await del(app, "/items/batch");
      expect(delRes.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size ?? 0).toBe(0);
    });
  });

  describe("auto-indexing disabled", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true, autoIndex: false },
        })
      );
    });

    it("should not index documents on create", async () => {
      const res = await post(app, "/items", { title: "Not Indexed" });
      expect(res.status).toBe(201);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size ?? 0).toBe(0);
    });

    it("should not update index on update", async () => {
      await searchAdapter.index("test_items", "manual", { title: "Manual" });

      const createRes = await post(app, "/items", { title: "Original" });
      expect(createRes.status).toBe(201);

      const patchRes = await patch(app, `/items/${createRes.body.id}`, { title: "Updated" });
      expect(patchRes.status).toBe(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size).toBe(1);
      expect(index?.get("manual")).toBeDefined();
    });

    it("should not remove from index on delete", async () => {
      const createRes = await post(app, "/items", { title: "Not Deleted" });
      expect(createRes.status).toBe(201);

      await searchAdapter.index("test_items", String(createRes.body.id), {
        title: "Manually Indexed",
      });

      const delRes = await del(app, `/items/${createRes.body.id}`);
      expect(delRes.status).toBe(204);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.has(String(createRes.body.id))).toBe(true);
    });
  });

  describe("custom index name", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: {
            enabled: true,
            indexName: "custom_items",
          },
        })
      );
    });

    it("should use custom index name for auto-indexing", async () => {
      const res = await post(app, "/items", { title: "Custom Index" });
      expect(res.status).toBe(201);

      expect(searchAdapter.getIndex("custom_items")?.size).toBe(1);
      expect(searchAdapter.getIndex("test_items")).toBeUndefined();
    });
  });

  describe("with existing hooks", () => {
    let hookCalled = false;

    beforeEach(() => {
      hookCalled = false;
      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          hooks: {
            onAfterCreate: async () => {
              hookCalled = true;
            },
          },
        })
      );
    });

    it("should call existing hooks alongside auto-indexing", async () => {
      const res = await post(app, "/items", { title: "With Hook" });
      expect(res.status).toBe(201);

      expect(hookCalled).toBe(true);
      expect(searchAdapter.getIndex("test_items")?.size).toBe(1);
    });
  });

  describe("index failure handling", () => {
    it("retries once, surfaces onIndexError, and does not fail the request", async () => {
      const errors: { operation: string; id: string }[] = [];
      let attempts = 0;
      // A flaky adapter whose index() always throws.
      const flaky = {
        ...createMemorySearchAdapter(),
        index: async () => {
          attempts++;
          throw new Error("index backend down");
        },
      };
      setGlobalSearch(flaky as any);

      app.route(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: {
            enabled: true,
            onIndexError: (info) => {
              errors.push({ operation: info.operation, id: info.id });
            },
          },
        })
      );

      // The create must still succeed even though indexing fails.
      const res = await post(app, "/items", { title: "Resilient" });
      expect(res.status).toBe(201);

      // One initial attempt + one retry = 2 calls, then onIndexError fires once.
      expect(attempts).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("index");
    });
  });
});
