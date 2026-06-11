import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { useResource, getResourceRegistry } from "@/resource/hook";
import {
  parseInclude,
  parseNestedFilter,
  RelationLoader,
  RelationsConfig,
} from "@/resource/relations";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { createTestApp, get } from "./helpers/hono";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  authorId: text("authorId").references(() => usersTable.id),
  categoryId: text("categoryId").references(() => categoriesTable.id),
});

const categoriesTable = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parentId"),
});

const commentsTable = sqliteTable("comments", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  postId: text("postId").references(() => postsTable.id),
  authorId: text("authorId").references(() => usersTable.id),
});

const profilesTable = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => usersTable.id),
  bio: text("bio"),
  website: text("website"),
});

const tagsTable = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const postTagsTable = sqliteTable("postTags", {
  postId: text("postId").references(() => postsTable.id),
  tagId: text("tagId").references(() => tagsTable.id),
});

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let app: Hono;
let kv: KVAdapter;

describe("Relations System", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-relations");
    await kv.connect();
    setGlobalKV(kv);

    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      );

      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parentId TEXT
      );

      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        authorId TEXT REFERENCES users(id),
        categoryId TEXT REFERENCES categories(id)
      );

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        postId TEXT REFERENCES posts(id),
        authorId TEXT REFERENCES users(id)
      );

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        userId TEXT REFERENCES users(id),
        bio TEXT,
        website TEXT
      );

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE postTags (
        postId TEXT REFERENCES posts(id),
        tagId TEXT REFERENCES tags(id)
      );
    `);
  });

  afterAll(async () => {
    sqlite.close();
    await kv.disconnect();
  });

  beforeEach(async () => {
    sqlite.exec("DELETE FROM postTags");
    sqlite.exec("DELETE FROM comments");
    sqlite.exec("DELETE FROM profiles");
    sqlite.exec("DELETE FROM posts");
    sqlite.exec("DELETE FROM tags");
    sqlite.exec("DELETE FROM categories");
    sqlite.exec("DELETE FROM users");

    getResourceRegistry().clear();
  });

  describe("parseInclude", () => {
    it("should return empty array for undefined input", () => {
      expect(parseInclude(undefined)).toEqual([]);
    });

    it("should return empty array for empty string", () => {
      expect(parseInclude("")).toEqual([]);
    });

    it("should parse single relation", () => {
      const result = parseInclude("author");
      expect(result).toEqual([{ relation: "author" }]);
    });

    it("should parse multiple relations", () => {
      const result = parseInclude("author,category,tags");
      expect(result).toEqual([
        { relation: "author" },
        { relation: "category" },
        { relation: "tags" },
      ]);
    });

    it("should parse relation with select option", () => {
      const result = parseInclude("author(select:id,name)");
      expect(result).toEqual([
        { relation: "author", select: ["id", "name"] },
      ]);
    });

    it("should parse relation with limit option", () => {
      const result = parseInclude("comments(limit:5)");
      expect(result).toEqual([
        { relation: "comments", limit: 5 },
      ]);
    });

    it("should parse relation with filter option", () => {
      const result = parseInclude("comments(filter:status==approved)");
      expect(result).toEqual([
        { relation: "comments", filter: "status==approved" },
      ]);
    });

    it("should parse relation with multiple options", () => {
      const result = parseInclude("comments(select:id,text;limit:10;filter:status==approved)");
      expect(result).toEqual([
        {
          relation: "comments",
          select: ["id", "text"],
          limit: 10,
          filter: "status==approved",
        },
      ]);
    });

    it("should parse nested relations with dot notation", () => {
      const result = parseInclude("author.profile");
      expect(result).toEqual([
        {
          relation: "author",
          nested: [{ relation: "profile" }],
        },
      ]);
    });

    it("should parse deeply nested relations", () => {
      const result = parseInclude("author.posts.comments");
      expect(result).toEqual([
        {
          relation: "author",
          nested: [
            {
              relation: "posts",
              nested: [{ relation: "comments" }],
            },
          ],
        },
      ]);
    });

    it("should parse mixed relations with nested and simple", () => {
      const result = parseInclude("author.profile,category,tags");
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        relation: "author",
        nested: [{ relation: "profile" }],
      });
      expect(result[1]).toEqual({ relation: "category" });
      expect(result[2]).toEqual({ relation: "tags" });
    });

    it("should handle whitespace in include string", () => {
      const result = parseInclude("author, category , tags");
      expect(result).toHaveLength(3);
      expect(result[0].relation).toBe("author");
      expect(result[1].relation).toBe("category");
      expect(result[2].relation).toBe("tags");
    });
  });

  describe("parseNestedFilter", () => {
    const relations: RelationsConfig = {
      author: {
        resource: "users",
        schema: usersTable,
        type: "belongsTo",
        foreignKey: postsTable.authorId,
        references: usersTable.id,
      },
      category: {
        resource: "categories",
        schema: categoriesTable,
        type: "belongsTo",
        foreignKey: postsTable.categoryId,
        references: categoriesTable.id,
      },
    };

    it("should parse local filter only", () => {
      const result = parseNestedFilter('status=="active"', relations);
      expect(result.localFilter).toBe('status=="active"');
      expect(result.relationFilters.size).toBe(0);
    });

    it("should separate relation filters from local filters", () => {
      const result = parseNestedFilter(
        'title=="Hello";author.name=="John"',
        relations
      );
      expect(result.localFilter).toBe('title=="Hello"');
      expect(result.relationFilters.get("author")).toBe('name=="John"');
    });

    it("should handle multiple relation filters", () => {
      const result = parseNestedFilter(
        'author.name=="John";category.name=="Tech"',
        relations
      );
      expect(result.localFilter).toBe("");
      expect(result.relationFilters.get("author")).toBe('name=="John"');
      expect(result.relationFilters.get("category")).toBe('name=="Tech"');
    });

    it("should combine multiple filters for same relation", () => {
      const result = parseNestedFilter(
        'author.name=="John";author.email=="john@example.com"',
        relations
      );
      expect(result.relationFilters.get("author")).toBe(
        'name=="John";email=="john@example.com"'
      );
    });

    it("should ignore non-existent relations in filter", () => {
      const result = parseNestedFilter(
        'nonexistent.field=="value";title=="Hello"',
        relations
      );
      expect(result.localFilter).toBe('nonexistent.field=="value";title=="Hello"');
      expect(result.relationFilters.size).toBe(0);
    });
  });

  describe("RelationLoader", () => {
    beforeEach(() => {
      db.insert(usersTable).values([
        { id: "user-1", name: "Alice", email: "alice@example.com" },
        { id: "user-2", name: "Bob", email: "bob@example.com" },
      ]).run();

      db.insert(categoriesTable).values([
        { id: "cat-1", name: "Technology", parentId: null },
        { id: "cat-2", name: "Science", parentId: null },
      ]).run();

      db.insert(postsTable).values([
        { id: "post-1", title: "First Post", content: "Content 1", authorId: "user-1", categoryId: "cat-1" },
        { id: "post-2", title: "Second Post", content: "Content 2", authorId: "user-1", categoryId: "cat-2" },
        { id: "post-3", title: "Third Post", content: "Content 3", authorId: "user-2", categoryId: "cat-1" },
        { id: "post-4", title: "Orphan Post", content: "No author", authorId: null, categoryId: null },
      ]).run();

      db.insert(commentsTable).values([
        { id: "comment-1", text: "Great post!", postId: "post-1", authorId: "user-2" },
        { id: "comment-2", text: "Nice work!", postId: "post-1", authorId: "user-1" },
        { id: "comment-3", text: "Interesting", postId: "post-2", authorId: "user-2" },
      ]).run();

      db.insert(profilesTable).values([
        { id: "profile-1", userId: "user-1", bio: "Developer", website: "https://alice.dev" },
      ]).run();

      db.insert(tagsTable).values([
        { id: "tag-1", name: "JavaScript" },
        { id: "tag-2", name: "TypeScript" },
        { id: "tag-3", name: "Rust" },
      ]).run();

      db.insert(postTagsTable).values([
        { postId: "post-1", tagId: "tag-1" },
        { postId: "post-1", tagId: "tag-2" },
        { postId: "post-2", tagId: "tag-2" },
        { postId: "post-3", tagId: "tag-3" },
      ]).run();
    });

    describe("belongsTo relations", () => {
      it("should load belongsTo relation", async () => {
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
        const post = { id: "post-1", title: "First Post", authorId: "user-1", categoryId: "cat-1" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "author" }],
          "id"
        );

        expect(result.author).toBeDefined();
        expect((result.author as any).id).toBe("user-1");
        expect((result.author as any).name).toBe("Alice");
      });

      it("should return null for null foreign key", async () => {
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
        const post = { id: "post-4", title: "Orphan Post", authorId: null, categoryId: null };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "author" }],
          "id"
        );

        expect(result.author).toBeNull();
      });

      it("should batch load belongsTo relations", async () => {
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
        const posts = [
          { id: "post-1", title: "First", authorId: "user-1" },
          { id: "post-2", title: "Second", authorId: "user-1" },
          { id: "post-3", title: "Third", authorId: "user-2" },
        ];

        const results = await loader.loadRelationsForItems(
          posts,
          [{ relation: "author" }],
          "id"
        );

        expect(results).toHaveLength(3);
        expect((results[0].author as any).name).toBe("Alice");
        expect((results[1].author as any).name).toBe("Alice");
        expect((results[2].author as any).name).toBe("Bob");
      });
    });

    describe("hasMany relations", () => {
      it("should load hasMany relation", async () => {
        const relations: RelationsConfig = {
          comments: {
            resource: "comments",
            schema: commentsTable,
            type: "hasMany",
            foreignKey: commentsTable.postId,
            references: postsTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-1", title: "First Post" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "comments" }],
          "id"
        );

        expect(Array.isArray(result.comments)).toBe(true);
        expect((result.comments as any[]).length).toBe(2);
      });

      it("should return empty array when no related items", async () => {
        const relations: RelationsConfig = {
          comments: {
            resource: "comments",
            schema: commentsTable,
            type: "hasMany",
            foreignKey: commentsTable.postId,
            references: postsTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-4", title: "Orphan Post" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "comments" }],
          "id"
        );

        expect(Array.isArray(result.comments)).toBe(true);
        expect((result.comments as any[]).length).toBe(0);
      });

      it("should batch load hasMany relations", async () => {
        const relations: RelationsConfig = {
          comments: {
            resource: "comments",
            schema: commentsTable,
            type: "hasMany",
            foreignKey: commentsTable.postId,
            references: postsTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const posts = [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
          { id: "post-3", title: "Third" },
        ];

        const results = await loader.loadRelationsForItems(
          posts,
          [{ relation: "comments" }],
          "id"
        );

        expect(results).toHaveLength(3);
        expect((results[0].comments as any[]).length).toBe(2);
        expect((results[1].comments as any[]).length).toBe(1);
        expect((results[2].comments as any[]).length).toBe(0);
      });
    });

    describe("hasOne relations", () => {
      it("should load hasOne relation", async () => {
        const relations: RelationsConfig = {
          profile: {
            resource: "profiles",
            schema: profilesTable,
            type: "hasOne",
            foreignKey: profilesTable.userId,
            references: usersTable.id,
          },
        };

        const loader = new RelationLoader(db, usersTable, relations, getResourceRegistry());
        const user = { id: "user-1", name: "Alice" };

        const result = await loader.loadRelationsForItem(
          user,
          [{ relation: "profile" }],
          "id"
        );

        expect(result.profile).toBeDefined();
        expect((result.profile as any).bio).toBe("Developer");
      });

      it("should return null when no related item", async () => {
        const relations: RelationsConfig = {
          profile: {
            resource: "profiles",
            schema: profilesTable,
            type: "hasOne",
            foreignKey: profilesTable.userId,
            references: usersTable.id,
          },
        };

        const loader = new RelationLoader(db, usersTable, relations, getResourceRegistry());
        const user = { id: "user-2", name: "Bob" };

        const result = await loader.loadRelationsForItem(
          user,
          [{ relation: "profile" }],
          "id"
        );

        expect(result.profile).toBeNull();
      });
    });

    describe("manyToMany relations", () => {
      it("should load manyToMany relation", async () => {
        const relations: RelationsConfig = {
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

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-1", title: "First Post" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "tags" }],
          "id"
        );

        expect(Array.isArray(result.tags)).toBe(true);
        expect((result.tags as any[]).length).toBe(2);
        const tagNames = (result.tags as any[]).map(t => t.name).sort();
        expect(tagNames).toEqual(["JavaScript", "TypeScript"]);
      });

      it("should return empty array when no tags", async () => {
        const relations: RelationsConfig = {
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

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-4", title: "Orphan Post" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "tags" }],
          "id"
        );

        expect(Array.isArray(result.tags)).toBe(true);
        expect((result.tags as any[]).length).toBe(0);
      });

      it("should batch load manyToMany relations", async () => {
        const relations: RelationsConfig = {
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

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const posts = [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
          { id: "post-3", title: "Third" },
        ];

        const results = await loader.loadRelationsForItems(
          posts,
          [{ relation: "tags" }],
          "id"
        );

        expect(results).toHaveLength(3);
        expect((results[0].tags as any[]).length).toBe(2);
        expect((results[1].tags as any[]).length).toBe(1);
        expect((results[2].tags as any[]).length).toBe(1);
      });
    });

    describe("select option", () => {
      it("should select only specified fields", async () => {
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
        const post = { id: "post-1", title: "First Post", authorId: "user-1" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "author", select: ["id", "name"] }],
          "id"
        );

        expect(result.author).toBeDefined();
        expect((result.author as any).id).toBe("user-1");
        expect((result.author as any).name).toBe("Alice");
        expect((result.author as any).email).toBeUndefined();
      });
    });

    describe("limit option", () => {
      it("should limit hasMany results", async () => {
        const relations: RelationsConfig = {
          comments: {
            resource: "comments",
            schema: commentsTable,
            type: "hasMany",
            foreignKey: commentsTable.postId,
            references: postsTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-1", title: "First Post" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "comments", limit: 1 }],
          "id"
        );

        expect((result.comments as any[]).length).toBe(1);
      });
    });

    describe("multiple relations", () => {
      it("should load multiple relations at once", async () => {
        const relations: RelationsConfig = {
          author: {
            resource: "users",
            schema: usersTable,
            type: "belongsTo",
            foreignKey: postsTable.authorId,
            references: usersTable.id,
          },
          category: {
            resource: "categories",
            schema: categoriesTable,
            type: "belongsTo",
            foreignKey: postsTable.categoryId,
            references: categoriesTable.id,
          },
          comments: {
            resource: "comments",
            schema: commentsTable,
            type: "hasMany",
            foreignKey: commentsTable.postId,
            references: postsTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const post = { id: "post-1", title: "First Post", authorId: "user-1", categoryId: "cat-1" };

        const result = await loader.loadRelationsForItem(
          post,
          [
            { relation: "author" },
            { relation: "category" },
            { relation: "comments" },
          ],
          "id"
        );

        expect(result.author).toBeDefined();
        expect((result.author as any).name).toBe("Alice");
        expect(result.category).toBeDefined();
        expect((result.category as any).name).toBe("Technology");
        expect((result.comments as any[]).length).toBe(2);
      });
    });

    describe("unknown relations", () => {
      it("should ignore unknown relations", async () => {
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
        const post = { id: "post-1", title: "First Post", authorId: "user-1" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "nonexistent" }],
          "id"
        );

        expect(result.nonexistent).toBeUndefined();
      });
    });

    describe("empty input", () => {
      it("should return items unchanged when no includes", async () => {
        const relations: RelationsConfig = {};
        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry());
        const posts = [{ id: "post-1", title: "First" }];

        const results = await loader.loadRelationsForItems(posts, [], "id");

        expect(results).toEqual(posts);
      });

      it("should return empty array when no items", async () => {
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

        const results = await loader.loadRelationsForItems(
          [],
          [{ relation: "author" }],
          "id"
        );

        expect(results).toEqual([]);
      });
    });

    describe("max depth", () => {
      it("should stop at max depth", async () => {
        const relations: RelationsConfig = {
          author: {
            resource: "users",
            schema: usersTable,
            type: "belongsTo",
            foreignKey: postsTable.authorId,
            references: usersTable.id,
          },
        };

        const loader = new RelationLoader(db, postsTable, relations, getResourceRegistry(), {
          maxDepth: 0,
        });
        const post = { id: "post-1", title: "First Post", authorId: "user-1" };

        const result = await loader.loadRelationsForItem(
          post,
          [{ relation: "author" }],
          "id",
          1
        );

        expect(result.author).toBeUndefined();
      });
    });
  });

  describe("HTTP Endpoint Integration", () => {
    beforeEach(() => {
      db.insert(usersTable).values([
        { id: "user-1", name: "Alice", email: "alice@example.com" },
        { id: "user-2", name: "Bob", email: "bob@example.com" },
      ]).run();

      db.insert(categoriesTable).values([
        { id: "cat-1", name: "Technology", parentId: null },
        { id: "cat-2", name: "Science", parentId: null },
      ]).run();

      db.insert(postsTable).values([
        { id: "post-1", title: "First Post", content: "Content 1", authorId: "user-1", categoryId: "cat-1" },
        { id: "post-2", title: "Second Post", content: "Content 2", authorId: "user-1", categoryId: "cat-2" },
        { id: "post-3", title: "Third Post", content: "Content 3", authorId: "user-2", categoryId: "cat-1" },
      ]).run();

      db.insert(commentsTable).values([
        { id: "comment-1", text: "Great post!", postId: "post-1", authorId: "user-2" },
        { id: "comment-2", text: "Nice work!", postId: "post-1", authorId: "user-1" },
        { id: "comment-3", text: "Interesting", postId: "post-2", authorId: "user-2" },
      ]).run();

      db.insert(tagsTable).values([
        { id: "tag-1", name: "JavaScript" },
        { id: "tag-2", name: "TypeScript" },
      ]).run();

      db.insert(postTagsTable).values([
        { postId: "post-1", tagId: "tag-1" },
        { postId: "post-1", tagId: "tag-2" },
        { postId: "post-2", tagId: "tag-2" },
      ]).run();

      app = createTestApp();

      app.route(
        "/api/users",
        useResource(usersTable, {
          db,
          id: usersTable.id,
          auth: { public: true },
        })
      );

      app.route(
        "/api/posts",
        useResource(postsTable, {
          db,
          id: postsTable.id,
          auth: { public: true },
          relations: {
            author: {
              resource: "users",
              schema: usersTable,
              type: "belongsTo",
              foreignKey: postsTable.authorId,
              references: usersTable.id,
            },
            category: {
              resource: "categories",
              schema: categoriesTable,
              type: "belongsTo",
              foreignKey: postsTable.categoryId,
              references: categoriesTable.id,
            },
            comments: {
              resource: "comments",
              schema: commentsTable,
              type: "hasMany",
              foreignKey: commentsTable.postId,
              references: postsTable.id,
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
            },
          },
        })
      );

      app.route(
        "/api/categories",
        useResource(categoriesTable, {
          db,
          id: categoriesTable.id,
          auth: { public: true },
        })
      );
    });

    describe("GET / with include", () => {
      it("should return items without relations when no include param", async () => {
        const res = await get(app, "/api/posts");

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(3);
        expect(res.body.items[0].author).toBeUndefined();
      });

      it("should include single belongsTo relation", async () => {
        const res = await get(app, "/api/posts?include=author");

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(3);
        expect(res.body.items[0].author).toBeDefined();
        expect(res.body.items[0].author.name).toBeDefined();
      });

      it("should include multiple relations", async () => {
        const res = await get(app, "/api/posts?include=author,category");

        expect(res.status).toBe(200);
        expect(res.body.items[0].author).toBeDefined();
        expect(res.body.items[0].category).toBeDefined();
      });

      it("should include hasMany relation", async () => {
        const res = await get(app, "/api/posts?include=comments");

        expect(res.status).toBe(200);
        const post1 = res.body.items.find((p: any) => p.id === "post-1");
        expect(Array.isArray(post1.comments)).toBe(true);
        expect(post1.comments.length).toBe(2);
      });

      it("should include manyToMany relation", async () => {
        const res = await get(app, "/api/posts?include=tags");

        expect(res.status).toBe(200);
        const post1 = res.body.items.find((p: any) => p.id === "post-1");
        expect(Array.isArray(post1.tags)).toBe(true);
        expect(post1.tags.length).toBe(2);
      });

      it("should include all relations", async () => {
        const res = await get(app, 
          "/api/posts?include=author,category,comments,tags"
        );

        expect(res.status).toBe(200);
        const post1 = res.body.items.find((p: any) => p.id === "post-1");
        expect(post1.author).toBeDefined();
        expect(post1.category).toBeDefined();
        expect(post1.comments).toHaveLength(2);
        expect(post1.tags).toHaveLength(2);
      });

      it("should work with pagination", async () => {
        const res = await get(app, "/api/posts?include=author&limit=2");

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.items[0].author).toBeDefined();
        expect(res.body.hasMore).toBe(true);
      });

      it("should work with filtering", async () => {
        const res = await get(app, 
          '/api/posts?include=author&filter=authorId=="user-1"'
        );

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.items[0].author.name).toBe("Alice");
      });

      it("should include with select option", async () => {
        const res = await get(app, 
          "/api/posts?include=author(select:id,name)"
        );

        expect(res.status).toBe(200);
        expect(res.body.items[0].author.id).toBeDefined();
        expect(res.body.items[0].author.name).toBeDefined();
        expect(res.body.items[0].author.email).toBeUndefined();
      });

      it("should include with limit option on single item", async () => {
        const res = await get(app, "/api/posts/post-1?include=comments(limit:1)");

        expect(res.status).toBe(200);
        expect(res.body.comments).toHaveLength(1);
      });

      it("should handle unknown relation gracefully", async () => {
        const res = await get(app, "/api/posts?include=nonexistent");

        expect(res.status).toBe(200);
        expect(res.body.items[0].nonexistent).toBeUndefined();
      });
    });

    describe("GET /:id with include", () => {
      it("should return item without relations when no include param", async () => {
        const res = await get(app, "/api/posts/post-1");

        expect(res.status).toBe(200);
        expect(res.body.id).toBe("post-1");
        expect(res.body.author).toBeUndefined();
      });

      it("should include single relation", async () => {
        const res = await get(app, "/api/posts/post-1?include=author");

        expect(res.status).toBe(200);
        expect(res.body.id).toBe("post-1");
        expect(res.body.author).toBeDefined();
        expect(res.body.author.name).toBe("Alice");
      });

      it("should include multiple relations", async () => {
        const res = await get(app, 
          "/api/posts/post-1?include=author,category,comments,tags"
        );

        expect(res.status).toBe(200);
        expect(res.body.author.name).toBe("Alice");
        expect(res.body.category.name).toBe("Technology");
        expect(res.body.comments).toHaveLength(2);
        expect(res.body.tags).toHaveLength(2);
      });

      it("should return 404 for non-existent item", async () => {
        const res = await get(app, 
          "/api/posts/nonexistent?include=author"
        );

        expect(res.status).toBe(404);
      });

      it("should handle null foreign key", async () => {
        db.insert(postsTable)
          .values({
            id: "post-orphan",
            title: "Orphan",
            authorId: null,
            categoryId: null,
          })
          .run();

        const res = await get(app, 
          "/api/posts/post-orphan?include=author,category"
        );

        expect(res.status).toBe(200);
        expect(res.body.author).toBeNull();
        expect(res.body.category).toBeNull();
      });
    });

    describe("resource without relations config", () => {
      it("should ignore include param when no relations configured", async () => {
        const res = await get(app, "/api/users?include=posts");

        expect(res.status).toBe(200);
        expect(res.body.items[0].posts).toBeUndefined();
      });
    });
  });

  describe("Edge Cases", () => {
    beforeEach(() => {
      db.insert(usersTable).values([
        { id: "user-1", name: "Alice", email: "alice@example.com" },
      ]).run();

      db.insert(postsTable).values([
        { id: "post-1", title: "Post", authorId: "user-1", categoryId: null },
      ]).run();

      app = createTestApp();

      app.route(
        "/api/posts",
        useResource(postsTable, {
          db,
          id: postsTable.id,
          auth: { public: true },
          relations: {
            author: {
              resource: "users",
              schema: usersTable,
              type: "belongsTo",
              foreignKey: postsTable.authorId,
              references: usersTable.id,
            },
          },
        })
      );
    });

    it("should handle special characters in include param", async () => {
      const res = await get(app, 
        "/api/posts?include=author(select:id,name)"
      );

      expect(res.status).toBe(200);
    });

    it("should handle empty include param", async () => {
      const res = await get(app, "/api/posts?include=");

      expect(res.status).toBe(200);
      expect(res.body.items[0].author).toBeUndefined();
    });

    it("should handle whitespace in include param", async () => {
      const res = await get(app, "/api/posts?include=%20author%20");

      expect(res.status).toBe(200);
      expect(res.body.items[0].author).toBeDefined();
    });

    it("should handle mixed valid and invalid relations", async () => {
      const res = await get(app, 
        "/api/posts?include=author,nonexistent,alsoInvalid"
      );

      expect(res.status).toBe(200);
      expect(res.body.items[0].author).toBeDefined();
      expect(res.body.items[0].nonexistent).toBeUndefined();
    });
  });
});
