import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { RelationLoader, RelationsConfig } from "@/resource/relations";
import { getResourceRegistry } from "@/resource/hook";

// JS property names deliberately differ from the DB column names (camelCase
// property bound to a snake_case column). Rows returned by drizzle are keyed by
// the JS property, but relation metadata carries the DB column name — the loader
// must bridge the two, otherwise belongsTo/hasMany silently resolve to null.
const authorsTable = sqliteTable("cn_authors", {
  authorId: text("author_id").primaryKey(),
  fullName: text("full_name").notNull(),
});

const booksTable = sqliteTable("cn_books", {
  bookId: text("book_id").primaryKey(),
  title: text("title").notNull(),
  writtenBy: text("written_by").references(() => authorsTable.authorId),
});

type Db = ReturnType<typeof drizzle>;

describe("Relation loader with renamed columns (DB name != JS property)", () => {
  let sqlite: Database.Database;
  let db: Db;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE cn_authors (author_id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
      CREATE TABLE cn_books (book_id TEXT PRIMARY KEY, title TEXT NOT NULL, written_by TEXT);
    `);
    db = drizzle(sqlite);
    db.insert(authorsTable).values([
      { authorId: "a1", fullName: "Ada" },
      { authorId: "a2", fullName: "Grace" },
    ]).run();
    db.insert(booksTable).values([
      { bookId: "b1", title: "One", writtenBy: "a1" },
      { bookId: "b2", title: "Two", writtenBy: "a2" },
      { bookId: "b3", title: "Three", writtenBy: "a1" },
      { bookId: "b4", title: "Orphan", writtenBy: null },
    ]).run();
  });

  afterEach(() => sqlite.close());

  const belongsTo: RelationsConfig = {
    author: {
      resource: "cn_authors",
      schema: authorsTable,
      type: "belongsTo",
      foreignKey: booksTable.writtenBy,
      references: authorsTable.authorId,
    },
  };

  const hasMany: RelationsConfig = {
    books: {
      resource: "cn_books",
      schema: booksTable,
      type: "hasMany",
      foreignKey: booksTable.writtenBy,
      references: authorsTable.authorId,
    },
  };

  it("resolves belongsTo through a renamed FK (single item)", async () => {
    const loader = new RelationLoader(db, booksTable, belongsTo, getResourceRegistry());
    const book = { bookId: "b1", title: "One", writtenBy: "a1" };

    const result = await loader.loadRelationsForItem(book, [{ relation: "author" }], "book_id");

    expect(result.author).not.toBeNull();
    expect((result.author as any).authorId).toBe("a1");
    expect((result.author as any).fullName).toBe("Ada");
  });

  it("still returns null for a genuinely null renamed FK", async () => {
    const loader = new RelationLoader(db, booksTable, belongsTo, getResourceRegistry());
    const book = { bookId: "b4", title: "Orphan", writtenBy: null };

    const result = await loader.loadRelationsForItem(book, [{ relation: "author" }], "book_id");

    expect(result.author).toBeNull();
  });

  it("resolves belongsTo through a renamed FK (batch/list path)", async () => {
    const loader = new RelationLoader(db, booksTable, belongsTo, getResourceRegistry());
    const books = (await db.select().from(booksTable)) as Record<string, unknown>[];

    const results = await loader.loadRelationsForItems(books, [{ relation: "author" }], "book_id");

    const byId = new Map(results.map((r) => [r.bookId, r]));
    expect((byId.get("b1")!.author as any).fullName).toBe("Ada");
    expect((byId.get("b2")!.author as any).fullName).toBe("Grace");
    expect((byId.get("b3")!.author as any).fullName).toBe("Ada");
    expect(byId.get("b4")!.author).toBeNull();
  });

  it("resolves hasMany through a renamed source id + FK (batch path)", async () => {
    const loader = new RelationLoader(db, authorsTable, hasMany, getResourceRegistry());
    const authors = (await db.select().from(authorsTable)) as Record<string, unknown>[];

    const results = await loader.loadRelationsForItems(authors, [{ relation: "books" }], "author_id");

    const byId = new Map(results.map((r) => [r.authorId, r]));
    expect((byId.get("a1")!.books as any[]).map((b) => b.bookId).sort()).toEqual(["b1", "b3"]);
    expect((byId.get("a2")!.books as any[]).map((b) => b.bookId)).toEqual(["b2"]);
  });

  it("warns (once) when the FK property was projected away", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = new RelationLoader(db, booksTable, belongsTo, getResourceRegistry());
    // Row without the writtenBy property at all (as if ?select= dropped it).
    const book = { bookId: "b1", title: "One" };

    const result = await loader.loadRelationsForItem(book, [{ relation: "author" }], "book_id");

    expect(result.author).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("writtenBy");
    warn.mockRestore();
  });
});
