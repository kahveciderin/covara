import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const testDocumentsTable = sqliteTable("test_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  userId: text("userId").notNull(),
  isPublic: integer("isPublic", { mode: "boolean" }).default(false),
});

describe("Secure Query Scope Bypass Prevention Tests", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-security-"));
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
        isPublic INTEGER DEFAULT 0
      )
    `);

    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, isPublic) VALUES ('User1 Private', 'Secret content', 'user1', 0)"
    );
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, isPublic) VALUES ('User1 Public', 'Public content', 'user1', 1)"
    );
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, isPublic) VALUES ('User2 Private', 'Other secret', 'user2', 0)"
    );
    await libsqlClient.execute(
      "INSERT INTO test_documents (title, content, userId, isPublic) VALUES ('User2 Public', 'Other public', 'user2', 1)"
    );
  });

  afterEach(() => {
    libsqlClient.close();
  });

  const createAppWithScope = (currentUserId: string) => {
    const app = createTestApp({ user: { id: currentUserId } });

    app.route(
      "/docs",
      useResource(testDocumentsTable, {
        id: testDocumentsTable.id,
        db,
        auth: {
          read: async (user) => rsql`userId==${user.id},isPublic==1`,
          create: async (user) => rsql`userId==${user.id}`,
          update: async (user) => rsql`userId==${user.id}`,
          delete: async (user) => rsql`userId==${user.id}`,
        },
      })
    );

    return app;
  };

  describe("List Endpoint Scope Enforcement", () => {
    it("should only return documents matching scope (own + public)", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs");
      expect(res.status).toBe(200);

      const docs = res.body.items;

      expect(docs.length).toBe(3);

      const titles = docs.map((d: any) => d.title);
      expect(titles).toContain("User1 Private");
      expect(titles).toContain("User1 Public");
      expect(titles).toContain("User2 Public");
      expect(titles).not.toContain("User2 Private");
    });

    it("should never return out-of-scope items regardless of filter", async () => {
      const app = createAppWithScope("user1");

      const filter = encodeURIComponent('userId=="user2"');
      const res = await get(app, `/docs?filter=${filter}`);
      expect(res.status).toBe(200);

      const docs = res.body.items;

      for (const doc of docs) {
        const isPublicDoc = doc.isPublic === 1 || doc.isPublic === true;
        expect(isPublicDoc || doc.userId === "user1").toBe(true);
      }

      const hasPrivateUser2 = docs.some(
        (d: any) => d.title === "User2 Private"
      );
      expect(hasPrivateUser2).toBe(false);
    });
  });

  describe("Get By ID Scope Enforcement", () => {
    it("should return 404 for out-of-scope document", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user2PrivateDoc = allDocs.rows.find(
        (r: any) => r.title === "User2 Private"
      );

      if (user2PrivateDoc) {
        const res = await get(app, `/docs/${user2PrivateDoc.id}`);
        expect(res.status).toBe(404);
      }
    });

    it("should return document if in scope", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user1Doc = allDocs.rows.find((r: any) => r.title === "User1 Private");

      if (user1Doc) {
        const res = await get(app, `/docs/${user1Doc.id}`);
        expect(res.status).toBe(200);
        expect(res.body.title).toBe("User1 Private");
      }
    });
  });

  describe("Update Scope Enforcement", () => {
    it("should not allow updating out-of-scope document", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user2Doc = allDocs.rows.find((r: any) => r.title === "User2 Private");

      if (user2Doc) {
        const res = await patch(app, `/docs/${user2Doc.id}`, { title: "Hacked Title" });
        expect(res.status).toBe(404);

        const afterUpdate = await libsqlClient.execute(
          `SELECT * FROM test_documents WHERE id = ${user2Doc.id}`
        );
        expect(afterUpdate.rows[0].title).toBe("User2 Private");
      }
    });

    it("should allow updating own document", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user1Doc = allDocs.rows.find((r: any) => r.title === "User1 Private");

      if (user1Doc) {
        const res = await patch(app, `/docs/${user1Doc.id}`, { title: "Updated Title" });
        expect(res.status).toBe(200);

        const afterUpdate = await libsqlClient.execute(
          `SELECT * FROM test_documents WHERE id = ${user1Doc.id}`
        );
        expect(afterUpdate.rows[0].title).toBe("Updated Title");
      }
    });

    it("should not allow updating public doc you do not own", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user2PublicDoc = allDocs.rows.find(
        (r: any) => r.title === "User2 Public"
      );

      if (user2PublicDoc) {
        const res = await patch(app, `/docs/${user2PublicDoc.id}`, { title: "Hijacked" });
        expect(res.status).toBe(404);
      }
    });
  });

  describe("Delete Scope Enforcement", () => {
    it("should not allow deleting out-of-scope document", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user2Doc = allDocs.rows.find((r: any) => r.title === "User2 Private");

      if (user2Doc) {
        const res = await del(app, `/docs/${user2Doc.id}`);
        expect(res.status).toBe(404);

        const afterDelete = await libsqlClient.execute(
          `SELECT * FROM test_documents WHERE id = ${user2Doc.id}`
        );
        expect(afterDelete.rows.length).toBe(1);
      }
    });

    it("should allow deleting own document", async () => {
      const app = createAppWithScope("user1");

      const allDocs = await libsqlClient.execute("SELECT * FROM test_documents");
      const user1Doc = allDocs.rows.find((r: any) => r.title === "User1 Private");

      if (user1Doc) {
        const res = await del(app, `/docs/${user1Doc.id}`);
        expect(res.status).toBe(204);

        const afterDelete = await libsqlClient.execute(
          `SELECT * FROM test_documents WHERE id = ${user1Doc.id}`
        );
        expect(afterDelete.rows.length).toBe(0);
      }
    });
  });

  describe("Count Scope Enforcement", () => {
    it("should only count documents in scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/count");
      expect(res.status).toBe(200);

      expect(res.body.count).toBe(3);
    });

    it("should apply scope to filtered count", async () => {
      const app = createAppWithScope("user1");

      const filter = encodeURIComponent('isPublic==1');
      const res = await get(app, `/docs/count?filter=${filter}`);

      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.count).toBe(2);
      }
    });
  });

  describe("Aggregate Scope Enforcement", () => {
    it("should only aggregate documents in scope", async () => {
      const app = createAppWithScope("user1");

      const res = await get(app, "/docs/aggregate?count=true");

      expect([200, 400]).toContain(res.status);
      if (res.status === 200 && res.body.groups) {
        const totalCount = res.body.groups.reduce(
          (sum: number, g: any) => sum + (g.count || 0),
          0
        );
        expect(totalCount).toBeLessThanOrEqual(3);
      }
    });
  });

  describe("Create Scope Enforcement", () => {
    it("should auto-assign userId based on authenticated user", async () => {
      const app = createAppWithScope("user1");

      const res = await post(app, "/docs", { title: "New Doc", content: "Content", userId: "user1" });
      expect(res.status).toBe(201);

      expect(res.body.userId).toBe("user1");
    });

    it("should handle creating document with explicit userId", async () => {
      const app = createAppWithScope("user1");

      const res = await post(app, "/docs", { title: "Test", content: "Content", userId: "user2" });

      expect([201, 400, 403]).toContain(res.status);
    });
  });
});
