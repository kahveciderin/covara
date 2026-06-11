import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post } from "../helpers/hono";

const authors = sqliteTable("authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("authorId"),
});

const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  postId: text("postId"),
});

describe("Nested write-through mutations", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-nested-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`CREATE TABLE authors (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
    await libsqlClient.execute(`CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId TEXT)`);
    await libsqlClient.execute(`CREATE TABLE comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, postId TEXT)`);

    app = createTestApp({ user: { id: "u" } });
    app.route(
      "/posts",
      useResource(posts, {
        id: posts.id,
        db,
        nestedWrites: true,
        relations: {
          author: {
            resource: "authors",
            schema: authors,
            type: "belongsTo",
            foreignKey: posts.authorId,
            references: authors.id,
          },
          comments: {
            resource: "comments",
            schema: comments,
            type: "hasMany",
            foreignKey: comments.postId,
            references: posts.id,
          },
        },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a belongsTo parent and wires the foreign key", async () => {
    const res = await post(app, "/posts", {
      id: "p1",
      title: "Hello",
      author: { id: "a1", name: "Alice" },
    });
    expect(res.status).toBe(201);
    expect(res.body.authorId).toBe("a1");

    const author = await db.select().from(authors).where(eq(authors.id, "a1"));
    expect(author).toHaveLength(1);
    expect(author[0].name).toBe("Alice");
  });

  it("creates hasMany children wired to the new row", async () => {
    const res = await post(app, "/posts", {
      id: "p2",
      title: "With comments",
      comments: [
        { id: "c1", body: "first" },
        { id: "c2", body: "second" },
      ],
    });
    expect(res.status).toBe(201);

    const childRows = await db.select().from(comments).where(eq(comments.postId, "p2"));
    expect(childRows.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("rolls back the whole graph if a nested insert fails", async () => {
    // Duplicate child id forces a failure after the parent insert.
    await db.insert(comments).values({ id: "dup", body: "exists" });

    const res = await post(app, "/posts", {
      id: "p3",
      title: "Should rollback",
      comments: [{ id: "dup", body: "conflict" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The post row must not exist — the transaction rolled back.
    const post3 = await db.select().from(posts).where(eq(posts.id, "p3"));
    expect(post3).toHaveLength(0);
  });
});
