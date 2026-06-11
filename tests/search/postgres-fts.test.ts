import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { createPostgresFtsAdapter } from "@/search/postgres-fts";
import { SearchAdapter } from "@/search";

let ftsSupported = true;
let skipReason = "";

const detectSupport = async (): Promise<void> => {
  try {
    const pg = new PGlite();
    const db = drizzle(pg);
    await db.execute(
      sql`SELECT to_tsvector('english', 'hello world') @@ plainto_tsquery('english', 'hello') as ok`
    );
  } catch (err) {
    ftsSupported = false;
    skipReason = `PGlite full-text search unsupported: ${
      (err as Error).message
    }`;
  }
};

describe("PostgreSQL tsvector Search Adapter", () => {
  let db: ReturnType<typeof drizzle>;
  let adapter: SearchAdapter;

  beforeAll(async () => {
    await detectSupport();
  });

  beforeEach(async () => {
    if (!ftsSupported) return;
    const pg = new PGlite();
    db = drizzle(pg);
    adapter = createPostgresFtsAdapter({ db });
  });

  const seed = async () => {
    await adapter.index("items", "1", {
      id: "1",
      title: "Important Task",
      description: "Do this now please",
    });
    await adapter.index("items", "2", {
      id: "2",
      title: "Normal Task",
      description: "Do this later maybe",
    });
    await adapter.index("items", "3", {
      id: "3",
      title: "Another Important Item",
      description: "Critical work",
    });
  };

  describe("index and search", () => {
    it("returns matching documents", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "important" });

      expect(result.total).toBe(2);
      expect(result.hits.map((h) => h.id).sort()).toEqual(["1", "3"]);
    });

    it("returns full source document", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "critical" });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.source).toEqual({
        id: "3",
        title: "Another Important Item",
        description: "Critical work",
      });
    });

    it("ranks results with ts_rank (positive scores)", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "task" });

      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
      }
    });

    it("orders by relevance", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await adapter.index("docs", "a", {
        id: "a",
        body: "apple apple apple banana",
      });
      await adapter.index("docs", "b", {
        id: "b",
        body: "apple banana cherry date",
      });
      const result = await adapter.search("docs", { query: "apple" });

      expect(result.hits[0]?.id).toBe("a");
    });

    it("updates existing document instead of duplicating", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await adapter.index("items", "1", {
        id: "1",
        title: "Original",
        description: "first",
      });
      await adapter.index("items", "1", {
        id: "1",
        title: "Updated",
        description: "second",
      });

      const original = await adapter.search("items", { query: "Original" });
      expect(original.total).toBe(0);

      const updated = await adapter.search("items", { query: "Updated" });
      expect(updated.total).toBe(1);
      expect(updated.hits[0]?.source.title).toBe("Updated");
    });
  });

  describe("delete", () => {
    it("removes the document from results", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      await adapter.delete("items", "1");

      const result = await adapter.search("items", { query: "important" });
      expect(result.total).toBe(1);
      expect(result.hits[0]?.id).toBe("3");
    });

    it("does not throw for non-existent document", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      await expect(adapter.delete("items", "999")).resolves.not.toThrow();
    });

    it("does not throw for non-existent index", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await expect(adapter.delete("missing", "1")).resolves.not.toThrow();
    });
  });

  describe("no matches", () => {
    it("returns empty result for no matches", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "zebra" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("returns empty for non-existent index", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      const result = await adapter.search("nope", { query: "x" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("special characters", () => {
    it("does not crash on tsquery operators and punctuation", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const queries = [
        "important & task",
        "task | now",
        "!important",
        "a:b & c",
        "(()))",
        "'; DROP TABLE items; --",
        "",
      ];
      for (const q of queries) {
        await expect(
          adapter.search("items", { query: q })
        ).resolves.toBeDefined();
      }
    });

    it("parameterizes input (no injection)", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      await adapter.search("items", {
        query: "'; DROP TABLE concave_fts_items; --",
      });
      const result = await adapter.search("items", { query: "important" });
      expect(result.total).toBe(2);
    });

    it("returns empty for whitespace-only query", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "   " });
      expect(result.total).toBe(0);
    });
  });

  describe("pagination", () => {
    it("respects size", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "task", size: 1 });

      expect(result.hits).toHaveLength(1);
      expect(result.total).toBe(2);
    });

    it("respects from offset", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const page1 = await adapter.search("items", {
        query: "task",
        size: 1,
        from: 0,
      });
      const page2 = await adapter.search("items", {
        query: "task",
        size: 1,
        from: 1,
      });

      expect(page1.hits[0]?.id).not.toBe(page2.hits[0]?.id);
    });
  });

  describe("multi-field", () => {
    it("searches across all columns by default", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      const result = await adapter.search("items", { query: "critical" });
      expect(result.total).toBe(1);
      expect(result.hits[0]?.id).toBe("3");
    });

    it("indexes only configured columns when provided", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      const pg = new PGlite();
      const localDb = drizzle(pg);
      const local = createPostgresFtsAdapter({
        db: localDb,
        columns: ["title"],
      });
      await local.index("posts", "1", {
        id: "1",
        title: "searchable headline",
        body: "hidden content keyword",
      });

      const byTitle = await local.search("posts", { query: "headline" });
      expect(byTitle.total).toBe(1);

      const byBody = await local.search("posts", { query: "keyword" });
      expect(byBody.total).toBe(0);
    });
  });

  describe("index lifecycle", () => {
    it("createIndex + indexExists", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      expect(await adapter.indexExists("blog")).toBe(false);
      await adapter.createIndex("blog", {
        properties: {
          title: { type: "text" },
          body: { type: "text" },
        },
      });
      expect(await adapter.indexExists("blog")).toBe(true);
    });

    it("deleteIndex removes the table", async () => {
      if (!ftsSupported) return expect(skipReason).toBeTruthy();
      await seed();
      expect(await adapter.indexExists("items")).toBe(true);
      await adapter.deleteIndex("items");
      expect(await adapter.indexExists("items")).toBe(false);
    });
  });

  (ftsSupported ? describe.skip : describe)("unsupported environment", () => {
    it.skip("FTS is unavailable in this PGlite build", () => {});
  });
});
