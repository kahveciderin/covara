import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createTestApp, get } from "../helpers/hono";

const authorsTable = sqliteTable("relscope_authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const booksTable = sqliteTable("relscope_books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("authorId").notNull(),
});

describe("Relation scope enforcement (included relations respect target auth)", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  const buildApp = (currentUserId: string) => {
    const app = createTestApp({ user: { id: currentUserId } });
    // authors: a user may only read their OWN author row
    app.route(
      "/authors",
      useResource(authorsTable, {
        id: authorsTable.id,
        db,
        auth: { read: async (u) => rsql`id==${u.id}` },
      })
    );
    // books: readable by any authenticated user, with a belongsTo author and a
    // hasMany (authors -> books would be the inverse; here books -> author)
    app.route(
      "/books",
      useResource(booksTable, {
        id: booksTable.id,
        db,
        relations: {
          author: {
            resource: "relscope_authors",
            schema: authorsTable,
            type: "belongsTo",
            foreignKey: booksTable.authorId,
            references: authorsTable.id,
          },
        },
      })
    );
    return app;
  };

  beforeEach(async () => {
    clearSchemaRegistry();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(
      `CREATE TABLE relscope_authors (id TEXT PRIMARY KEY, name TEXT NOT NULL)`
    );
    await libsqlClient.execute(
      `CREATE TABLE relscope_books (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId TEXT NOT NULL)`
    );
    await libsqlClient.execute("INSERT INTO relscope_authors VALUES ('a1','Alice')");
    await libsqlClient.execute("INSERT INTO relscope_authors VALUES ('a2','Bob')");
    await libsqlClient.execute("INSERT INTO relscope_books VALUES ('b1','Book One','a1')");
    await libsqlClient.execute("INSERT INTO relscope_books VALUES ('b2','Book Two','a2')");
  });

  afterEach(() => {
    libsqlClient.close();
    clearSchemaRegistry();
  });

  it("nulls out an included relation the user could not read directly", async () => {
    const app = buildApp("a1");
    const res = await get(app, "/books?include=author");
    expect(res.status).toBe(200);
    const byId: Record<string, any> = {};
    for (const b of res.body.items) byId[b.id] = b;
    // a1 may read their own author row...
    expect(byId.b1.author?.id).toBe("a1");
    // ...but NOT a2's author row, even via the relation
    expect(byId.b2.author).toBeNull();
  });

  it("matches direct-read scope (control: a1 cannot GET a2's author)", async () => {
    const app = buildApp("a1");
    const denied = await get(app, "/authors/a2");
    expect(denied.status).toBe(404);
    const allowed = await get(app, "/authors/a1");
    expect(allowed.status).toBe(200);
  });

  it("lets a different user see only their own included author", async () => {
    const app = buildApp("a2");
    const res = await get(app, "/books?include=author");
    const byId: Record<string, any> = {};
    for (const b of res.body.items) byId[b.id] = b;
    expect(byId.b1.author).toBeNull();
    expect(byId.b2.author?.id).toBe("a2");
  });
});
