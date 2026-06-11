import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createSqliteFtsAdapter } from "@/search/sqlite-fts";
import { SearchAdapter } from "@/search";

describe("SQLite FTS5 Search Adapter", () => {
  let db: ReturnType<typeof drizzle>;
  let adapter: SearchAdapter;

  beforeEach(() => {
    const client = createClient({ url: ":memory:" });
    db = drizzle(client);
    adapter = createSqliteFtsAdapter({ db });
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
      await seed();
      const result = await adapter.search("items", { query: "important" });

      expect(result.total).toBe(2);
      expect(result.hits.map((h) => h.id).sort()).toEqual(["1", "3"]);
    });

    it("returns the full source document", async () => {
      await seed();
      const result = await adapter.search("items", { query: "critical" });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.source).toEqual({
        id: "3",
        title: "Another Important Item",
        description: "Critical work",
      });
    });

    it("ranks results with bm25 (positive scores)", async () => {
      await seed();
      const result = await adapter.search("items", { query: "task" });

      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
      }
    });

    it("orders results by relevance", async () => {
      await adapter.index("docs", "a", {
        id: "a",
        body: "apple apple apple banana",
      });
      await adapter.index("docs", "b", {
        id: "b",
        body: "apple banana banana banana",
      });
      const result = await adapter.search("docs", { query: "apple" });

      expect(result.hits[0]?.id).toBe("a");
    });

    it("updates an existing document instead of duplicating", async () => {
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
      await seed();
      await adapter.delete("items", "1");

      const result = await adapter.search("items", { query: "important" });
      expect(result.total).toBe(1);
      expect(result.hits[0]?.id).toBe("3");
    });

    it("does not throw for non-existent document", async () => {
      await seed();
      await expect(adapter.delete("items", "999")).resolves.not.toThrow();
    });

    it("does not throw for non-existent index", async () => {
      await expect(adapter.delete("missing", "1")).resolves.not.toThrow();
    });
  });

  describe("no matches", () => {
    it("returns empty result for no matches", async () => {
      await seed();
      const result = await adapter.search("items", { query: "zebra" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("returns empty for non-existent index", async () => {
      const result = await adapter.search("nope", { query: "x" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("FTS special characters", () => {
    it("does not crash on FTS operators and punctuation", async () => {
      await seed();
      const queries = [
        'important OR "task"',
        "NEAR(a b)",
        "* AND ^",
        '"unterminated',
        "task: important - now",
        "(()))",
        "",
      ];
      for (const q of queries) {
        await expect(
          adapter.search("items", { query: q })
        ).resolves.toBeDefined();
      }
    });

    it("treats operators as literal terms (no injection)", async () => {
      await adapter.index("items", "10", {
        id: "10",
        title: "alpha beta gamma",
        description: "x",
      });
      const literal = await adapter.search("items", { query: "alpha beta" });
      expect(literal.total).toBe(1);

      const withOperatorToken = await adapter.search("items", {
        query: "alpha OR gamma",
      });
      expect(withOperatorToken.total).toBe(0);
    });

    it("returns empty for whitespace-only query", async () => {
      await seed();
      const result = await adapter.search("items", { query: "   " });
      expect(result.total).toBe(0);
    });
  });

  describe("pagination", () => {
    it("respects size", async () => {
      await seed();
      const result = await adapter.search("items", { query: "task", size: 1 });

      expect(result.hits).toHaveLength(1);
      expect(result.total).toBe(2);
    });

    it("respects from offset", async () => {
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
      await seed();
      const result = await adapter.search("items", { query: "critical" });
      expect(result.total).toBe(1);
      expect(result.hits[0]?.id).toBe("3");
    });

    it("restricts to specified fields", async () => {
      await seed();
      const titleOnly = await adapter.search("items", {
        query: "critical",
        fields: ["title"],
      });
      expect(titleOnly.total).toBe(0);

      const descOnly = await adapter.search("items", {
        query: "critical",
        fields: ["description"],
      });
      expect(descOnly.total).toBe(1);
    });

    it("returns empty when filtering on unknown fields only", async () => {
      await seed();
      const result = await adapter.search("items", {
        query: "important",
        fields: ["nonexistent"],
      });
      expect(result.total).toBe(0);
    });
  });

  describe("highlights", () => {
    it("returns highlights when requested", async () => {
      await seed();
      const result = await adapter.search("items", {
        query: "important",
        highlight: true,
      });
      expect(result.hits[0]?.highlights).toBeDefined();
    });

    it("omits highlights by default", async () => {
      await seed();
      const result = await adapter.search("items", { query: "important" });
      expect(result.hits[0]?.highlights).toBeUndefined();
    });
  });

  describe("index lifecycle", () => {
    it("createIndex + indexExists", async () => {
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
      await seed();
      expect(await adapter.indexExists("items")).toBe(true);
      await adapter.deleteIndex("items");
      expect(await adapter.indexExists("items")).toBe(false);
    });
  });

  describe("configured columns", () => {
    it("indexes only configured columns", async () => {
      const client = createClient({ url: ":memory:" });
      const localDb = drizzle(client);
      const local = createSqliteFtsAdapter({
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
});
