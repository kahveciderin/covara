import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { useResource, getResourceRegistry } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { discoverRelations } from "@/resource/relations";
import { createTestApp, request, SSECollector } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const people = sqliteTable("rx_people", {
  id: text("person_id").primaryKey(),
  fullName: text("full_name"),
  secret: text("secret"),
});
const posts = sqliteTable("rx_posts", {
  id: text("id").primaryKey(),
  title: text("title"),
  hidden: text("hidden"),
  authorId: text("authorId").references(() => people.id),
});
const links = sqliteTable("rx_links", {
  id: text("id").primaryKey(),
  postId: text("postId"),
  personId: text("personId"),
});

const author = {
  resource: "rx_people",
  schema: people,
  type: "belongsTo",
  foreignKey: posts.authorId,
  references: people.id,
} as const;
const reviewers = {
  resource: "rx_people",
  schema: people,
  type: "manyToMany",
  foreignKey: posts.id,
  references: people.id,
  through: { schema: links, sourceKey: links.postId, targetKey: links.personId },
} as const;
const written = {
  resource: "rx_posts",
  schema: posts,
  type: "hasMany",
  foreignKey: posts.authorId,
  references: people.id,
} as const;
const favorite = { ...written, type: "hasOne" } as const;

describe("relation includes expose only allowed columns", () => {
  let t: TempDb;

  beforeEach(async () => {
    clearSchemaRegistry();
    getResourceRegistry().clear();
    t = await openTempDb(`
      CREATE TABLE rx_people (person_id TEXT PRIMARY KEY, full_name TEXT, secret TEXT);
      CREATE TABLE rx_posts (id TEXT PRIMARY KEY, title TEXT, hidden TEXT, authorId TEXT REFERENCES rx_people(person_id));
      CREATE TABLE rx_links (id TEXT PRIMARY KEY, postId TEXT, personId TEXT);
      INSERT INTO rx_people VALUES ('u1', 'Ann', 'TOP-SECRET');
      INSERT INTO rx_posts VALUES ('p1', 'a', 'HIDDEN-POST', 'u1');
      INSERT INTO rx_links VALUES ('l1', 'p1', 'u1');
    `);
  });
  afterEach(() => t.close());

  const build = (postsConfig: Record<string, unknown>, peopleConfig?: Record<string, unknown>) => {
    const app = createTestApp({ user: { id: "viewer" } });
    app.route("/posts", useResource(posts, { id: posts.id, db: t.db, ...postsConfig } as any));
    if (peopleConfig) {
      app.route("/people", useResource(people, { id: people.id, db: t.db, ...peopleConfig } as any));
    }
    return app;
  };
  const include = (spec: string) => `include=${encodeURIComponent(spec)}`;

  describe("autoRelations", () => {
    it.each(["/posts", "/posts/p1"])("does not follow a key to an unregistered table on %s", async (path) => {
      const res = await request(build({ autoRelations: true }), "GET", `${path}?include=author`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("TOP-SECRET");
      expect((res.body.items?.[0] ?? res.body).author).toBeUndefined();
    });

    it("loads the table once it is registered", async () => {
      const res = await request(build({ autoRelations: true }, {}), "GET", "/posts/p1?include=author");
      expect(res.body.author.fullName).toBe("Ann");
    });

    it("discovers only registered tables by default", () => {
      expect(discoverRelations(posts as any, new Map())).toEqual({});
    });

    it("still lets a trusted scope traverse an unregistered table", async () => {
      const app = build({ auth: { read: async () => rsql`author.fullName=="Ann"` } });
      const res = await request(app, "GET", "/posts");
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("defaultSelect", () => {
    const limited = () =>
      build({
        relations: {
          author: { ...author, defaultSelect: [people.fullName] },
          reviewers: { ...reviewers, defaultSelect: [people.fullName] },
        },
      });

    it.each(["/posts?", "/posts/p1?"])("limits belongsTo and manyToMany on %s", async (path) => {
      const res = await request(limited(), "GET", `${path}${include("author,reviewers")}`);
      const item = res.body.items?.[0] ?? res.body;
      expect(item.author).toEqual({ fullName: "Ann" });
      expect(item.reviewers).toEqual([{ fullName: "Ann" }]);
    });

    it.each(["/posts?", "/posts/p1?"])("intersects a client select on %s", async (path) => {
      const res = await request(limited(), "GET", `${path}${include("author(select:secret,fullName)")}`);
      expect((res.body.items?.[0] ?? res.body).author).toEqual({ fullName: "Ann" });
    });

    it("returns no columns when the client selects only forbidden ones", async () => {
      const res = await request(limited(), "GET", `/posts/p1?${include("author(select:secret)")}`);
      expect(res.body.author).toEqual({});
    });

    it("cannot be probed with an include filter", async () => {
      const res = await request(limited(), "GET", `/posts/p1?${include('author(filter:secret=="TOP-SECRET")')}`);
      expect(res.status).toBe(400);
    });
  });

  describe("target fields.readable", () => {
    const readable = { fields: { readable: [people.fullName] } };

    it.each(["/posts?", "/posts/p1?"])("masks belongsTo and manyToMany on %s", async (path) => {
      const app = build({ relations: { author, reviewers } }, readable);
      const res = await request(app, "GET", `${path}${include("author,reviewers")}`);
      const item = res.body.items?.[0] ?? res.body;
      expect(item.author).toEqual({ fullName: "Ann" });
      expect(item.reviewers).toEqual([{ fullName: "Ann" }]);
    });

    it("masks discovered relations", async () => {
      const res = await request(build({ autoRelations: true }, readable), "GET", "/posts/p1?include=author");
      expect(res.body.author).toEqual({ fullName: "Ann" });
    });

    it("masks eager relations", async () => {
      const app = build({ relations: { author: { ...author, strategy: "eager" } } }, readable);
      expect((await request(app, "GET", "/posts/p1")).body.author).toEqual({ fullName: "Ann" });
    });

    it.each(["/people?", "/people/u1?"])("masks hasMany and hasOne on %s", async (path) => {
      const app = build({ fields: { readable: [posts.title] } }, { relations: { written, favorite } });
      const res = await request(app, "GET", `${path}${include("written,favorite")}`);
      const item = res.body.items?.[0] ?? res.body;
      expect(item.written).toEqual([{ title: "a" }]);
      expect(item.favorite).toEqual({ title: "a" });
    });

    it.each(["/people?", "/people/u1?"])("masks both levels of a nested include on %s", async (path) => {
      const app = build(
        { relations: { author }, fields: { readable: [posts.title] } },
        { relations: { written }, fields: { readable: [people.id, people.fullName] } }
      );
      const res = await request(app, "GET", `${path}${include("written.author")}`);
      const item = res.body.items?.[0] ?? res.body;
      expect(item.written).toEqual([{ title: "a", author: { id: "u1", fullName: "Ann" } }]);
    });

    it("does not let a nested name unmask a column", async () => {
      const app = build({ relations: { author } }, { ...readable, relations: { written } });
      const res = await request(app, "GET", `/posts/p1?${include("author.secret")}`);
      expect(JSON.stringify(res.body)).not.toContain("TOP-SECRET");
    });

    it("uses the table's policy when relation.resource is named differently", async () => {
      const app = build({ relations: { author: { ...author, resource: "users" } } }, readable);
      expect((await request(app, "GET", "/posts/p1?include=author")).body.author).toEqual({ fullName: "Ann" });
    });

    it("uses the table's scope when relation.resource is named differently", async () => {
      const app = build(
        { relations: { author: { ...author, resource: "users" } } },
        { auth: { read: async () => rsql`id=="someone-else"` } }
      );
      expect((await request(app, "GET", "/posts/p1?include=author")).body.author).toBeNull();
    });

    it("masks relations in subscription events", async () => {
      const app = build({ relations: { author } }, readable);
      const { collector } = await SSECollector.connect(app, "/posts/subscribe?include=author");
      try {
        await collector.next();
        await collector.next();
        await request(app, "PATCH", "/posts/p1", { title: "b" });
        const event = await collector.next();
        expect(event?.data.object.author).toEqual({ fullName: "Ann" });
      } finally {
        collector.close();
      }
    });
  });

  it("rejects relation paths in include filters", async () => {
    const app = build({ relations: { author } }, { relations: { written } });
    const res = await request(app, "GET", `/posts/p1?${include('author(filter:written.hidden=="HIDDEN-POST")')}`);
    expect(res.status).toBe(400);
  });

  it("a subscriber's bad include cannot fail another user's write", async () => {
    const app = build({ relations: { author } }, { fields: { readable: [people.fullName] } });
    const spec = include('author(filter:secret=="x")');
    const { collector } = await SSECollector.connect(app, `/posts/subscribe?${spec}`);
    try {
      await collector.next();
      await collector.next();
      expect((await request(app, "PATCH", "/posts/p1", { title: "b" })).status).toBe(200);
    } finally {
      collector.close();
    }
  });
});
