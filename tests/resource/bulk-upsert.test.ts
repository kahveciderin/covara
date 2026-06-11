import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post } from "../helpers/hono";

const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  qty: integer("qty").notNull().default(0),
});

describe("Bulk upsert (POST /batch/upsert)", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-upsert-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(
      `CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0)`
    );
    app = createTestApp({ user: { id: "u" } });
    app.route("/items", useResource(items, { id: items.id, db, batch: { create: 100 } }));
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inserts new rows and updates existing ones in one call", async () => {
    await post(app, "/items", { id: "1", name: "Old", qty: 1 });

    const res = await post(app, "/items/batch/upsert", {
      items: [
        { id: "1", name: "Updated", qty: 5 }, // existing -> update
        { id: "2", name: "New", qty: 9 }, // new -> insert
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const one = await get(app, "/items/1");
    expect(one.body.name).toBe("Updated");
    expect(one.body.qty).toBe(5);

    const two = await get(app, "/items/2");
    expect(two.body.name).toBe("New");
    expect(two.body.qty).toBe(9);

    const all = await get(app, "/items");
    expect(all.body.items).toHaveLength(2);
  });

  it("is idempotent on repeated upsert of the same rows", async () => {
    const payload = { items: [{ id: "1", name: "A", qty: 1 }] };
    await post(app, "/items/batch/upsert", payload);
    await post(app, "/items/batch/upsert", payload);

    const all = await get(app, "/items");
    expect(all.body.items).toHaveLength(1);
  });
});
