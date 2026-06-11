import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import {
  setGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
} from "@/search";
import { createTestApp, get } from "../helpers/hono";

const testDocumentsTable = sqliteTable("test_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  userId: text("userId").notNull(),
  category: text("category").default("general"),
  score: integer("score").default(0),
  isPublic: integer("isPublic", { mode: "boolean" }).default(false),
});

describe("Endpoint Auth Scope Enforcement", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let searchAdapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-auth-scope-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_documents`);
    await libsqlClient.execute(`
      CREATE TABLE test_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        userId TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        score INTEGER DEFAULT 0,
        isPublic INTEGER DEFAULT 0
      )
    `);

    // Insert test data
    // User1's documents
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, category, score, isPublic) VALUES ('User1 Private Doc', 'Secret content from user1', 'user1', 'work', 10, 0)"
    );
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, category, score, isPublic) VALUES ('User1 Public Doc', 'Public content from user1', 'user1', 'personal', 20, 1)"
    );
    // User2's documents
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, category, score, isPublic) VALUES ('User2 Private Doc', 'Secret content from user2', 'user2', 'work', 30, 0)"
    );
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, category, score, isPublic) VALUES ('User2 Public Doc', 'Public content from user2', 'user2', 'personal', 40, 1)"
    );
    // User3's documents
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, category, score, isPublic) VALUES ('User3 Private Doc', 'Secret content from user3', 'user3', 'work', 50, 0)"
    );

    // Setup search adapter
    searchAdapter = createMemorySearchAdapter();
    setGlobalSearch(searchAdapter);

    // Index all documents for search
    const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
    for (const doc of allDocs.rows) {
      await searchAdapter.index("test_documents", String(doc.id), doc as Record<string, unknown>);
    }
  });

  afterEach(() => {
    libsqlClient.close();
    clearGlobalSearch();
  });

  const createAppWithScope = (currentUserId: string) => {
    const app = createTestApp({ user: { id: currentUserId } });

    app.route(
      "/docs",
      useResource(testDocumentsTable, {
        id: testDocumentsTable.id,
        db,
        search: { enabled: true },
        auth: {
          // User can read their own docs + public docs
          read: async (user) => rsql`userId==${user.id},isPublic==1`,
          create: async (user) => rsql`userId==${user.id}`,
          update: async (user) => rsql`userId==${user.id}`,
          delete: async (user) => rsql`userId==${user.id}`,
        },
      })
    );

    return app;
  };

  describe("Count Endpoint Scope Enforcement", () => {
    it("should only count documents within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/count");
      expect(res.status).toBe(200);

      // user1 should see: user1's 2 docs + user2's 1 public doc + user3's 0 public docs = 3 total
      expect(res.body.count).toBe(3);
    });

    it("should not count other users' private documents", async () => {
      const app = createAppWithScope("user1");

      // Try to filter for user2's docs - should only get public ones
      const filter = encodeURIComponent('userId=="user2"');
      const res = await get(app, `/docs/count?filter=${filter}`);
      expect(res.status).toBe(200);

      // Should only count user2's public doc, not the private one
      expect(res.body.count).toBe(1);
    });

    it("should return different counts for different users", async () => {
      const appUser1 = createAppWithScope("user1");
      const appUser2 = createAppWithScope("user2");

      const resUser1 = await get(appUser1, "/docs/count");
      expect(resUser1.status).toBe(200);
      const resUser2 = await get(appUser2, "/docs/count");
      expect(resUser2.status).toBe(200);

      // user1: own 2 docs + 2 public docs from others = but user2 public is already counted, user3 has no public
      // Actually: user1 private, user1 public, user2 public = 3
      expect(resUser1.body.count).toBe(3);

      // user2: own 2 docs + user1 public = 3
      expect(resUser2.body.count).toBe(3);
    });

    it("should combine user filter with auth scope using AND", async () => {
      const app = createAppWithScope("user1");

      // Filter for work category
      const filter = encodeURIComponent('category=="work"');
      const res = await get(app, `/docs/count?filter=${filter}`);
      expect(res.status).toBe(200);

      // user1 has 1 work doc (private), but user2 and user3's work docs are private and not visible
      expect(res.body.count).toBe(1);
    });
  });

  describe("Aggregate Endpoint Scope Enforcement", () => {
    it("should only aggregate documents within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?count=true");
      expect(res.status).toBe(200);

      // Total count should be 3 (user1's 2 docs + user2's public doc)
      const totalCount = res.body.groups.reduce(
        (sum: number, g: any) => sum + (g.count || 0),
        0
      );
      expect(totalCount).toBe(3);
    });

    it("should only sum scores from documents within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?sum=score");
      expect(res.status).toBe(200);

      // user1 private (10) + user1 public (20) + user2 public (40) = 70
      // Should NOT include user2 private (30) or user3 private (50)
      const totalSum = res.body.groups.reduce(
        (sum: number, g: any) => sum + (g.sum?.score || 0),
        0
      );
      expect(totalSum).toBe(70);
    });

    it("should only average scores from documents within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?avg=score");
      expect(res.status).toBe(200);

      // Average of 10, 20, 40 = 70/3 ≈ 23.33
      const avg = res.body.groups[0]?.avg?.score;
      expect(avg).toBeCloseTo(70 / 3, 1);
    });

    it("should group by category only within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?groupBy=category&count=true");
      expect(res.status).toBe(200);

      const groups = res.body.groups;
      const workGroup = groups.find((g: any) => g.key?.category === "work");
      const personalGroup = groups.find((g: any) => g.key?.category === "personal");

      // Work category: only user1's work doc (user2 and user3's work docs are private)
      expect(workGroup?.count).toBe(1);

      // Personal category: user1 public + user2 public = 2
      expect(personalGroup?.count).toBe(2);
    });

    it("should not leak aggregate data from out-of-scope documents", async () => {
      const app = createAppWithScope("user1");

      // Try to filter for user3's docs
      const filter = encodeURIComponent('userId=="user3"');
      const res = await get(app, `/docs/aggregate?filter=${filter}&count=true`);
      expect(res.status).toBe(200);

      // user3 has no public docs, so count should be 0
      const totalCount = res.body.groups.reduce(
        (sum: number, g: any) => sum + (g.count || 0),
        0
      );
      expect(totalCount).toBe(0);
    });

    it("should apply min/max only to documents within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?min=score&max=score");
      expect(res.status).toBe(200);

      // Min should be 10 (user1 private), max should be 40 (user2 public)
      // Should NOT include user3's 50 (private)
      expect(res.body.groups[0]?.min?.score).toBe(10);
      expect(res.body.groups[0]?.max?.score).toBe(40);
    });
  });

  describe("Search Endpoint Scope Enforcement", () => {
    it("should only return search results within auth scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/search?q=content");
      expect(res.status).toBe(200);

      // Should find documents with "content" in title/content, but only within scope
      // user1 should see: user1 private, user1 public, user2 public
      // Should NOT see: user2 private, user3 private
      expect(res.body.items.length).toBeLessThanOrEqual(3);

      const userIds = res.body.items.map((item: any) => item.userId);
      const hasUser2Private = res.body.items.some(
        (item: any) => item.userId === "user2" && item.isPublic === 0
      );
      const hasUser3Private = res.body.items.some(
        (item: any) => item.userId === "user3"
      );

      expect(hasUser2Private).toBe(false);
      expect(hasUser3Private).toBe(false);
    });

    it("should not return other users private documents in search", async () => {
      const app = createAppWithScope("user1");

      // Search for "Secret" which appears in all private docs
      const res = await get(app, "/docs/search?q=Secret");
      expect(res.status).toBe(200);

      // Should only find user1's private doc, not user2's or user3's
      for (const item of res.body.items) {
        const isOwnDoc = item.userId === "user1";
        const isPublicDoc = item.isPublic === 1 || item.isPublic === true;
        expect(isOwnDoc || isPublicDoc).toBe(true);
      }
    });

    it("should apply auth scope even with additional filter", async () => {
      const app = createAppWithScope("user1");

      // Try to search and filter for user2's documents
      const filter = encodeURIComponent('userId=="user2"');
      const res = await get(app, `/docs/search?q=content&filter=${filter}`);
      expect(res.status).toBe(200);

      // Should only return user2's PUBLIC documents
      for (const item of res.body.items) {
        if (item.userId === "user2") {
          expect(item.isPublic === 1 || item.isPublic === true).toBe(true);
        }
      }

      // Should not contain user2's private doc
      const hasUser2Private = res.body.items.some(
        (item: any) => item.userId === "user2" && (item.isPublic === 0 || item.isPublic === false)
      );
      expect(hasUser2Private).toBe(false);
    });

    it("should return different search results for different users", async () => {
      const appUser1 = createAppWithScope("user1");
      const appUser2 = createAppWithScope("user2");

      // Search for "Private" which appears in all private doc titles
      const resUser1 = await get(appUser1, "/docs/search?q=Private");
      expect(resUser1.status).toBe(200);
      const resUser2 = await get(appUser2, "/docs/search?q=Private");
      expect(resUser2.status).toBe(200);

      // user1 should only see their own private doc
      expect(resUser1.body.items.every((item: any) =>
        item.userId === "user1" || item.isPublic === 1 || item.isPublic === true
      )).toBe(true);

      // user2 should only see their own private doc
      expect(resUser2.body.items.every((item: any) =>
        item.userId === "user2" || item.isPublic === 1 || item.isPublic === true
      )).toBe(true);
    });

    it("should not expose total count of out-of-scope documents", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/search?q=content");
      expect(res.status).toBe(200);

      // Total should only count documents within scope
      // There are 5 total docs with "content", but user1 should only see 3
      expect(res.body.total).toBeLessThanOrEqual(3);
    });

    it("should enforce scope when searching specific fields", async () => {
      const app = createAppWithScope("user1");

      // Search for "user2" which appears in user2's content
      const res = await get(app, "/docs/search?q=user2");
      expect(res.status).toBe(200);

      // Should only return user2's public doc if it matches
      for (const item of res.body.items) {
        const isOwnDoc = item.userId === "user1";
        const isPublicDoc = item.isPublic === 1 || item.isPublic === true;
        expect(isOwnDoc || isPublicDoc).toBe(true);
      }
    });
  });

  describe("Unauthenticated Access", () => {
    const createAppWithoutAuth = () => {
      const app = createTestApp({ user: null });

      app.route(
        "/docs",
        useResource(testDocumentsTable, {
          id: testDocumentsTable.id,
          db,
          search: { enabled: true },
          auth: {
            read: async (user) => rsql`userId==${user.id},isPublic==1`,
          },
        })
      );

      return app;
    };

    it("should deny count access for unauthenticated users with auth configured", async () => {
      const app = createAppWithoutAuth();
      const res = await get(app, "/docs/count");
      expect([401, 403]).toContain(res.status);
    });

    it("should deny aggregate access for unauthenticated users with auth configured", async () => {
      const app = createAppWithoutAuth();
      const res = await get(app, "/docs/aggregate?count=true");
      expect([401, 403]).toContain(res.status);
    });

    it("should deny search access for unauthenticated users with auth configured", async () => {
      const app = createAppWithoutAuth();
      const res = await get(app, "/docs/search?q=test");
      expect([401, 403]).toContain(res.status);
    });
  });

  describe("Public Read Access", () => {
    const createAppWithPublicRead = () => {
      const app = createTestApp({ user: null });

      app.route(
        "/docs",
        useResource(testDocumentsTable, {
          id: testDocumentsTable.id,
          db,
          search: { enabled: true },
          auth: {
            public: { read: true }, // Allow public read
            update: async (user) => rsql`userId==${user.id}`,
            delete: async (user) => rsql`userId==${user.id}`,
          },
        })
      );

      return app;
    };

    it("should allow count access with public read", async () => {
      const app = createAppWithPublicRead();
      const res = await get(app, "/docs/count");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(5); // All 5 documents
    });

    it("should allow aggregate access with public read", async () => {
      const app = createAppWithPublicRead();
      const res = await get(app, "/docs/aggregate?count=true");
      expect(res.status).toBe(200);
      const totalCount = res.body.groups.reduce(
        (sum: number, g: any) => sum + (g.count || 0),
        0
      );
      expect(totalCount).toBe(5); // All 5 documents
    });

    it("should allow search access with public read", async () => {
      const app = createAppWithPublicRead();
      const res = await get(app, "/docs/search?q=content");
      expect(res.status).toBe(200);
      // All documents have "content" in them
      expect(res.body.items.length).toBe(5);
    });
  });
});
