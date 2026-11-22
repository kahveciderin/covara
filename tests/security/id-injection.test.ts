import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { createTestApp, request } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const docs = sqliteTable("idi_docs", {
  id: text("id").primaryKey(),
  title: text("title"),
  ownerId: text("ownerId"),
  hidden: integer("hidden"),
});
const numbered = sqliteTable("idi_numbered", {
  id: integer("id").primaryKey(),
  title: text("title"),
});

describe("the /:id path segment is a literal", () => {
  let t: TempDb;

  beforeEach(async () => {
    t = await openTempDb(`
      CREATE TABLE idi_docs (id TEXT PRIMARY KEY, title TEXT, ownerId TEXT, hidden INTEGER);
      CREATE TABLE idi_numbered (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO idi_docs VALUES ('p1', 'a', 'u1', 70), ('p2', 'b', 'u2', 10);
      INSERT INTO idi_numbered VALUES (5, 'five');
    `);
  });
  afterEach(() => t.close());

  const build = (extra: Record<string, unknown> = {}) => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/docs",
      useResource(docs, { id: docs.id, db: t.db, fields: { readable: [docs.id, docs.title] }, ...extra } as any)
    );
    app.route("/numbered", useResource(numbered, { id: numbered.id, db: t.db }));
    return app;
  };
  const count = async () => (await t.client.execute("SELECT * FROM idi_docs WHERE title IN ('a','b')")).rows.length;

  const payloads = [
    'p1";hidden>50;id!="x',
    'p1";hidden>90;id!="x',
    'x",id!="',
    'x"),(id!="',
    'x" or id!="',
    'x"||id!="',
  ];

  it.each(payloads)("GET does not evaluate %s", async (payload) => {
    expect((await request(build(), "GET", `/docs/${encodeURIComponent(payload)}`)).status).toBe(404);
  });

  it.each(["PATCH", "PUT", "DELETE"])("%s does not evaluate an injected id", async (method) => {
    const body = method === "DELETE" ? undefined : { id: "p1", title: "changed" };
    const res = await request(build(), method, `/docs/${encodeURIComponent('x",id!="')}`, body);
    expect(res.status).toBe(404);
    expect(await count()).toBe(2);
  });

  it.each(['say "hi"', "back\\slash", "trailing\\", "O'Brien", "2026-11-22", "a;b,c", "(x)", "true", "007"])(
    "finds the id %s exactly",
    async (id) => {
      await t.client.execute({ sql: "INSERT INTO idi_docs VALUES (?, 't', 'u1', 0)", args: [id] });
      const res = await request(build(), "GET", `/docs/${encodeURIComponent(id)}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
    }
  );

  it("matches integer keys", async () => {
    expect((await request(build(), "GET", "/numbered/5")).body.title).toBe("five");
    expect((await request(build(), "GET", "/numbered/5x")).status).toBe(404);
  });

  it("still applies the scope", async () => {
    const app = build({ auth: { read: async () => rsql`ownerId=="u1"` } });
    expect((await request(app, "GET", "/docs/p1")).status).toBe(200);
    expect((await request(app, "GET", "/docs/p2")).status).toBe(404);
  });

  it("does not let a custom operator's OR escape the id match", async () => {
    const { sql } = await import("drizzle-orm");
    const app = build({
      auth: { read: async () => rsql`ownerId=either="u1"` },
      customOperators: {
        "=either=": { convert: (l: any, r: any) => sql`${l} = ${r} OR ${l} = 'u2'`, execute: () => true },
      },
    });
    expect((await request(app, "GET", "/docs/nope")).status).toBe(404);
  });
});
