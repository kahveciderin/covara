import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { setGlobalSearch, clearGlobalSearch, createMemorySearchAdapter } from "@/search";
import { createTestApp, request } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const docs = sqliteTable("sfo_docs", {
  id: text("id").primaryKey(),
  title: text("title"),
  hidden: integer("hidden"),
});

describe("search evaluates the filter it validated", () => {
  let t: TempDb;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    t = await openTempDb("CREATE TABLE sfo_docs (id TEXT PRIMARY KEY, title TEXT, hidden INTEGER);");
    const search = createMemorySearchAdapter();
    setGlobalSearch(search);
    await search.index("sfo_docs", "a", { id: "a", title: "word", hidden: 70 });
    app = createTestApp({ user: { id: "u1" } });
    app.route("/docs", useResource(docs, { id: docs.id, db: t.db, fields: { readable: [docs.id, docs.title] } }));
  });
  afterEach(() => {
    clearGlobalSearch();
    t.close();
  });

  const search = (filter: string) => request(app, "GET", `/docs/search?q=word&filter=${encodeURIComponent(filter)}`);

  it("cannot be made to compare a hidden column inside a string literal", async () => {
    const probe = (n: number) => search(`title!="\\\\";title!="z;hidden>${n};title!=q"`);
    expect((await probe(90)).body.items).toEqual((await probe(50)).body.items);
  });

  it("applies an ordinary filter", async () => {
    expect((await search('title=="word"')).body.items).toHaveLength(1);
    expect((await search('title=="other"')).body.items).toHaveLength(0);
  });

  it("rejects an unparseable filter with a 400", async () => {
    expect((await search("title==")).status).toBe(400);
  });

  it("rejects a relation path with a 400", async () => {
    expect((await search('owner.secret=="x"')).status).toBe(400);
  });
});
