import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, del } from "../helpers/hono";

const notesTable = sqliteTable("notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  deletedAt: text("deletedAt"),
});

describe("Soft delete", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-softdel-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        deletedAt TEXT
      )
    `);

    app = createTestApp({ user: { id: "u" } });
    app.route(
      "/notes",
      useResource(notesTable, {
        id: notesTable.id,
        db,
        softDelete: { field: "deletedAt" },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seed = (id: string) => post(app, "/notes", { id, title: `Note ${id}` });

  it("marks the row deleted instead of removing it, and hides it from reads", async () => {
    await seed("1");
    const delRes = await del(app, "/notes/1");
    expect(delRes.status).toBe(204);

    // Hidden from get
    const getRes = await get(app, "/notes/1");
    expect(getRes.status).toBe(404);

    // Hidden from list
    const list = await get(app, "/notes");
    expect(list.body.items).toHaveLength(0);

    // But the row physically still exists (soft-deleted)
    const raw = await db.select().from(notesTable);
    expect(raw).toHaveLength(1);
    expect(raw[0].deletedAt).not.toBeNull();
  });

  it("exposes soft-deleted rows with ?withDeleted=true", async () => {
    await seed("1");
    await del(app, "/notes/1");

    const list = await get(app, "/notes?withDeleted=true");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].deletedAt).toBeTruthy();

    const one = await get(app, "/notes/1?withDeleted=true");
    expect(one.status).toBe(200);
  });

  it("does not count soft-deleted rows", async () => {
    await seed("1");
    await seed("2");
    await del(app, "/notes/1");

    const count = await get(app, "/notes/count");
    expect(count.body.count).toBe(1);
  });

  it("returns 404 when deleting an already soft-deleted row", async () => {
    await seed("1");
    await del(app, "/notes/1");
    const second = await del(app, "/notes/1");
    expect(second.status).toBe(404);
  });
});
