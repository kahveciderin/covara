import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, del } from "../helpers/hono";

const docs = sqliteTable("docs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  secret: text("secret"),
  version: integer("version").default(0),
  deletedAt: text("deletedAt"),
});

// Configure entirely with Drizzle column objects (the preferred form) instead of
// string column names, and assert the resource behaves the same.
describe("resource config with Drizzle column references", () => {
  let app: Hono;
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-colref-"));
  });
  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(client);
    await client.execute(`DROP TABLE IF EXISTS docs`);
    await client.execute(
      `CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, secret TEXT, version INTEGER DEFAULT 0, deletedAt TEXT)`
    );

    app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/docs",
      useResource(docs, {
        id: docs.id,
        db,
        fields: { readable: [docs.id, docs.title, docs.version], writable: [docs.title, docs.secret] },
        etag: { versionField: docs.version },
        softDelete: { field: docs.deletedAt },
        batch: { delete: 100 },
      })
    );
  });

  afterEach(() => client.close());

  it("applies read masking from column-object fields.readable", async () => {
    await post(app, "/docs", { id: "a", title: "Hello", secret: "shh" });
    const res = await get(app, "/docs/a");
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Hello");
    // `secret` is not in readable -> masked out.
    expect("secret" in res.body).toBe(false);
  });

  it("emits an ETag from the column-object versionField", async () => {
    await post(app, "/docs", { id: "b", title: "Tagged" });
    const res = await get(app, "/docs/b");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("soft-deletes via the column-object softDelete.field", async () => {
    await post(app, "/docs", { id: "c", title: "Temp" });
    const deleted = await del(app, "/docs/c");
    expect(deleted.status).toBe(204);

    // Excluded from normal reads...
    const listed = await get(app, "/docs");
    expect(listed.body.items.find((i: any) => i.id === "c")).toBeUndefined();
    // ...but the row still exists (soft delete), visible with ?withDeleted=true.
    const withDeleted = await get(app, "/docs?withDeleted=true");
    expect(withDeleted.body.items.find((i: any) => i.id === "c")).toBeTruthy();
  });
});
