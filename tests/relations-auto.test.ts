import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { discoverRelations } from "@/resource/relations";
import { rsql } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createTestApp, get } from "./helpers/hono";

const authorsTable = sqliteTable("auto_authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const booksTable = sqliteTable("auto_books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("authorId").references(() => authorsTable.id),
});

describe("Relation auto-discovery", () => {
  it("discovers belongsTo from own FKs and hasMany from inverse FKs", () => {
    const registry = new Map<string, { schema: any }>([
      ["auto_authors", { schema: authorsTable }],
      ["auto_books", { schema: booksTable }],
    ]);
    const fromBooks = discoverRelations(booksTable as any, registry as any);
    expect(fromBooks.author?.type).toBe("belongsTo");
    expect(fromBooks.author?.resource).toBe("auto_authors");

    const fromAuthors = discoverRelations(authorsTable as any, registry as any);
    expect(fromAuthors.auto_books?.type).toBe("hasMany");
    expect(fromAuthors.auto_books?.resource).toBe("auto_books");
  });

  describe("over HTTP", () => {
    let libsqlClient: ReturnType<typeof createLibsqlClient>;
    let db: ReturnType<typeof drizzle>;

    const buildApp = (userId: string, scopeAuthors: boolean) => {
      const app = createTestApp({ user: { id: userId } });
      app.route(
        "/authors",
        useResource(authorsTable, {
          id: authorsTable.id,
          db,
          autoRelations: true,
          ...(scopeAuthors ? { auth: { read: async (u: any) => rsql`id==${u.id}` } } : {}),
        })
      );
      app.route(
        "/books",
        useResource(booksTable, { id: booksTable.id, db, autoRelations: true })
      );
      return app;
    };

    beforeEach(async () => {
      clearSchemaRegistry();
      libsqlClient = createLibsqlClient({ url: ":memory:" });
      db = drizzle(libsqlClient);
      await libsqlClient.execute(`CREATE TABLE auto_authors (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
      await libsqlClient.execute(
        `CREATE TABLE auto_books (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId TEXT REFERENCES auto_authors(id))`
      );
      await libsqlClient.execute("INSERT INTO auto_authors VALUES ('a1','Alice')");
      await libsqlClient.execute("INSERT INTO auto_authors VALUES ('a2','Bob')");
      await libsqlClient.execute("INSERT INTO auto_books VALUES ('b1','One','a1')");
      await libsqlClient.execute("INSERT INTO auto_books VALUES ('b2','Two','a2')");
    });

    afterEach(() => {
      libsqlClient.close();
      clearSchemaRegistry();
    });

    it("loads a discovered belongsTo via ?include", async () => {
      const app = buildApp("a1", false);
      const res = await get(app, "/books?include=author");
      expect(res.status).toBe(200);
      const byId: Record<string, any> = {};
      for (const b of res.body.items) byId[b.id] = b;
      expect(byId.b1.author?.name).toBe("Alice");
      expect(byId.b2.author?.name).toBe("Bob");
    });

    it("loads a discovered hasMany (inverse) via ?include", async () => {
      const app = buildApp("a1", false);
      const res = await get(app, "/authors/a1?include=auto_books");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.auto_books)).toBe(true);
      expect(res.body.auto_books.map((b: any) => b.id)).toEqual(["b1"]);
    });

    it("enforces the target scope on discovered relations", async () => {
      const app = buildApp("a1", true);
      const res = await get(app, "/books?include=author");
      const byId: Record<string, any> = {};
      for (const b of res.body.items) byId[b.id] = b;
      expect(byId.b1.author?.id).toBe("a1");
      expect(byId.b2.author).toBeNull();
    });
  });
});
