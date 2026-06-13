import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { changelog } from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).default(false),
});

// Cloudflare D1 has no interactive transactions. We simulate that engine on top
// of libsql by forcing `transactions: false` and making db.transaction THROW —
// so any code path that still reaches for an interactive transaction fails loudly.
describe("D1 mode (transactions: false)", () => {
  let app: Hono;
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle>;
  let kv: KVAdapter;
  let tempDir: string;
  let transactionSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-d1-"));
    kv = createMemoryKV("d1-test");
    await kv.connect();
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    await changelog.clear();
    client = createClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(client);
    await client.execute(`DROP TABLE IF EXISTS items`);
    await client.execute(`CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER DEFAULT 0)`);

    // Hard fail if any route reaches for an interactive transaction.
    transactionSpy = vi.fn(() => {
      throw new Error("D1: interactive transactions are not supported");
    });
    (db as any).transaction = transactionSpy;

    app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/items",
      useResource(items, {
        id: items.id,
        db,
        transactions: false,
        batch: { create: 100, update: 100 },
      })
    );
  });

  afterEach(() => {
    client.close();
  });

  it("create / update / delete work without interactive transactions", async () => {
    const created = await post(app, "/items", { id: "a", title: "First" });
    expect(created.status).toBe(201);

    const updated = await patch(app, "/items/a", { title: "Updated" });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Updated");

    const listed = await get(app, "/items");
    expect(listed.body.items).toHaveLength(1);

    const deleted = await del(app, "/items/a");
    expect(deleted.status).toBe(204);

    const afterDelete = await get(app, "/items");
    expect(afterDelete.body.items).toHaveLength(0);

    // The whole point: nothing tried to BEGIN a transaction.
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("records exactly one changelog entry per mutation (single-statement, auto-committed)", async () => {
    await post(app, "/items", { id: "a", title: "First" });
    await patch(app, "/items/a", { title: "Updated" });

    const entries = await changelog.getEntriesSince("items", 0);
    const forA = entries.filter((e) => e.objectId === "a");
    expect(forA.filter((e) => e.type === "create")).toHaveLength(1);
    expect(forA.filter((e) => e.type === "update")).toHaveLength(1);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("batch upsert is applied atomically via db.batch instead of a transaction", async () => {
    await post(app, "/items", { id: "a", title: "Existing" });

    const batchSpy = vi.spyOn(db as any, "batch");
    const res = await post(app, "/items/batch/upsert", {
      items: [
        { id: "a", title: "Updated via upsert" },
        { id: "b", title: "Inserted via upsert" },
      ],
    });
    expect(res.status).toBe(200);

    const listed = await get(app, "/items?orderBy=id:asc");
    const byId = Object.fromEntries(listed.body.items.map((i: any) => [i.id, i]));
    expect(byId.a.title).toBe("Updated via upsert");
    expect(byId.b.title).toBe("Inserted via upsert");

    // The multi-statement path used db.batch (D1's atomic primitive), not a transaction.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});
