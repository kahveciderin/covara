import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { RelationLoader, RelationsConfig } from "@/resource/relations";
import { getResourceRegistry } from "@/resource/hook";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("authorId").references(() => usersTable.id),
});

const commentsTable = sqliteTable("comments", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").notNull(),
  postId: text("postId").references(() => postsTable.id),
});

const tagsTable = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
});

const postTagsTable = sqliteTable("postTags", {
  postId: text("postId").references(() => postsTable.id),
  tagId: text("tagId").references(() => tagsTable.id),
});

const profilesTable = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => usersTable.id),
  bio: text("bio"),
  visibility: text("visibility").notNull(),
});

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

const commentsRelation: RelationsConfig = {
  comments: {
    resource: "comments",
    schema: commentsTable,
    type: "hasMany",
    foreignKey: commentsTable.postId,
    references: postsTable.id,
  },
};

const tagsRelation: RelationsConfig = {
  tags: {
    resource: "tags",
    schema: tagsTable,
    type: "manyToMany",
    foreignKey: postsTable.id,
    references: tagsTable.id,
    through: {
      schema: postTagsTable,
      sourceKey: postTagsTable.postId,
      targetKey: postTagsTable.tagId,
    },
  },
};

describe("Relations Advanced", () => {
  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId TEXT);
      CREATE TABLE comments (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL, postId TEXT);
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE postTags (postId TEXT, tagId TEXT);
      CREATE TABLE profiles (id TEXT PRIMARY KEY, userId TEXT, bio TEXT, visibility TEXT NOT NULL);
    `);
  });

  afterAll(() => sqlite.close());

  beforeEach(() => {
    sqlite.exec("DELETE FROM postTags");
    sqlite.exec("DELETE FROM comments");
    sqlite.exec("DELETE FROM profiles");
    sqlite.exec("DELETE FROM posts");
    sqlite.exec("DELETE FROM tags");
    sqlite.exec("DELETE FROM users");
    getResourceRegistry().clear();

    db.insert(usersTable)
      .values([{ id: "user-1", name: "Alice" }])
      .run();

    db.insert(postsTable)
      .values([
        { id: "post-1", title: "First", authorId: "user-1" },
        { id: "post-2", title: "Second", authorId: "user-1" },
      ])
      .run();

    db.insert(commentsTable)
      .values([
        { id: "c-1", text: "a", status: "approved", postId: "post-1" },
        { id: "c-2", text: "b", status: "approved", postId: "post-1" },
        { id: "c-3", text: "c", status: "pending", postId: "post-1" },
        { id: "c-4", text: "d", status: "approved", postId: "post-2" },
        { id: "c-5", text: "e", status: "approved", postId: "post-2" },
        { id: "c-6", text: "f", status: "approved", postId: "post-2" },
      ])
      .run();

    db.insert(tagsTable)
      .values([
        { id: "tag-1", name: "js", kind: "lang" },
        { id: "tag-2", name: "ts", kind: "lang" },
        { id: "tag-3", name: "fun", kind: "topic" },
        { id: "tag-4", name: "rust", kind: "lang" },
        { id: "tag-5", name: "news", kind: "topic" },
      ])
      .run();

    db.insert(postTagsTable)
      .values([
        { postId: "post-1", tagId: "tag-1" },
        { postId: "post-1", tagId: "tag-2" },
        { postId: "post-1", tagId: "tag-3" },
        { postId: "post-2", tagId: "tag-2" },
        { postId: "post-2", tagId: "tag-4" },
        { postId: "post-2", tagId: "tag-5" },
      ])
      .run();
  });

  describe("include filter (hasMany)", () => {
    it("only returns matching related rows", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        commentsRelation,
        getResourceRegistry()
      );

      const result = await loader.loadRelationsForItem(
        { id: "post-1", title: "First" },
        [{ relation: "comments", filter: 'status=="approved"' }],
        "id"
      );

      const comments = result.comments as any[];
      expect(comments).toHaveLength(2);
      expect(comments.every((c) => c.status === "approved")).toBe(true);
    });

    it("applies filter in batch loading without bleeding across parents", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        commentsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "comments", filter: 'status=="approved"' }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.comments as any[]).map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
      expect((p2.comments as any[]).map((c) => c.id).sort()).toEqual(["c-4", "c-5", "c-6"]);
    });
  });

  describe("include filter (manyToMany)", () => {
    it("only returns matching related rows", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        tagsRelation,
        getResourceRegistry()
      );

      const result = await loader.loadRelationsForItem(
        { id: "post-1", title: "First" },
        [{ relation: "tags", filter: 'kind=="lang"' }],
        "id"
      );

      const tags = result.tags as any[];
      expect(tags.map((t) => t.name).sort()).toEqual(["js", "ts"]);
    });

    it("applies filter in batch loading without bleeding across parents", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        tagsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "tags", filter: 'kind=="lang"' }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.tags as any[]).map((t) => t.name).sort()).toEqual(["js", "ts"]);
      expect((p2.tags as any[]).map((t) => t.name).sort()).toEqual(["rust", "ts"]);
    });
  });

  describe("include filter on belongsTo / hasOne", () => {
    it("yields null when belongsTo target does not match filter", async () => {
      const relations: RelationsConfig = {
        author: {
          resource: "users",
          schema: usersTable,
          type: "belongsTo",
          foreignKey: postsTable.authorId,
          references: usersTable.id,
        },
      };
      const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());

      const result = await loader.loadRelationsForItem(
        { id: "post-1", title: "First", authorId: "user-1" },
        [{ relation: "author", filter: 'name=="Nobody"' }],
        "id"
      );

      expect(result.author).toBeNull();
    });
  });

  describe("include limit per parent (batch)", () => {
    it("hasMany: each parent gets exactly limit rows, no bleed", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        commentsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "comments", limit: 2 }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.comments as any[]).length).toBe(2);
      expect((p2.comments as any[]).length).toBe(2);
      expect((p1.comments as any[]).every((c) => c.postId === "post-1" || c.postId === undefined)).toBe(true);
    });

    it("manyToMany: each parent gets exactly limit rows, no bleed", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        tagsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "tags", limit: 2 }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.tags as any[]).length).toBe(2);
      expect((p2.tags as any[]).length).toBe(2);
    });

    it("no-limit batch still returns all rows", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        commentsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "comments" }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.comments as any[]).length).toBe(3);
      expect((p2.comments as any[]).length).toBe(3);
    });

    it("combines filter and limit per parent", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        commentsRelation,
        getResourceRegistry()
      );

      const results = await loader.loadRelationsForItems(
        [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
        [{ relation: "comments", filter: 'status=="approved"', limit: 1 }],
        "id"
      );

      const p1 = results.find((r) => r.id === "post-1")!;
      const p2 = results.find((r) => r.id === "post-2")!;
      expect((p1.comments as any[]).length).toBe(1);
      expect((p1.comments as any[])[0].status).toBe("approved");
      expect((p2.comments as any[]).length).toBe(1);
    });
  });

  describe("eager / lazy strategy", () => {
    const lazyRelations: RelationsConfig = {
      comments: {
        resource: "comments",
        schema: commentsTable,
        type: "hasMany",
        foreignKey: commentsTable.postId,
        references: postsTable.id,
        strategy: "lazy",
      },
      tags: {
        resource: "tags",
        schema: tagsTable,
        type: "manyToMany",
        foreignKey: postsTable.id,
        references: tagsTable.id,
        through: {
          schema: postTagsTable,
          sourceKey: postTagsTable.postId,
          targetKey: postTagsTable.tagId,
        },
        strategy: "eager",
      },
    };

    it("getEagerIncludes returns only eager relations", () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        lazyRelations,
        getResourceRegistry()
      );

      const eager = loader.getEagerIncludes();
      expect(eager).toEqual([{ relation: "tags" }]);
    });

    it("lazy relation is absent unless explicitly included", async () => {
      const loader = new RelationLoader(
        db,
        postsTable,
        lazyRelations,
        getResourceRegistry()
      );

      const eagerOnly = await loader.loadRelationsForItem(
        { id: "post-1", title: "First" },
        loader.getEagerIncludes(),
        "id"
      );
      expect(eagerOnly.comments).toBeUndefined();
      expect(Array.isArray(eagerOnly.tags)).toBe(true);

      const withLazy = await loader.loadRelationsForItem(
        { id: "post-1", title: "First" },
        [{ relation: "comments" }],
        "id"
      );
      expect(Array.isArray(withLazy.comments)).toBe(true);
      expect((withLazy.comments as any[]).length).toBe(3);
    });
  });
});
