import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { changelog } from "@/resource/changelog";
import { createTestApp, patch, del } from "../helpers/hono";

const itemsTable = sqliteTable("txn_consistency_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  value: integer("value").notNull(),
});

const resourceName = "txn_consistency_items";

const changelogEntriesForResource = async () =>
  changelog.getEntriesForResources([resourceName], 0);

describe("changelog / transaction consistency", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-txn-consistency-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({
      url: `file:${join(tempDir, "test.db")}`,
    });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS ${resourceName}`);
    await libsqlClient.execute(`
      CREATE TABLE ${resourceName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `);

    await changelog.clear();

    app = createTestApp({ user: {} });
  });

  afterEach(() => {
    libsqlClient.close();
  });

  const seedOne = async () => {
    const [row] = await db
      .insert(itemsTable)
      .values({ name: "alpha", value: 1 })
      .returning();
    return row as { id: number; name: string; value: number };
  };

  describe("batch update rolls back the changelog when the transaction fails", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(itemsTable, {
          id: itemsTable.id,
          db,
          hooks: {
            onAfterUpdate: async () => {
              throw new Error("after-update boom");
            },
          },
        })
      );
    });

    it("does not leave a phantom changelog entry for an uncommitted update", async () => {
      const seeded = await seedOne();

      const res = await patch(app, '/items/batch?filter=name=="alpha"', {
        value: 999,
      });
      expect(res.status).toBe(500);

      // The DB transaction rolled back, so the row is unchanged.
      const [row] = await db.select().from(itemsTable);
      expect((row as any).value).toBe(1);

      // The changelog must NOT contain an entry for a mutation that never committed.
      const entries = await changelogEntriesForResource();
      const phantom = entries.filter(
        (e) => e.type === "update" && e.objectId === String(seeded.id)
      );
      expect(phantom).toHaveLength(0);
    });
  });

  describe("batch delete rolls back the changelog when the transaction fails", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(itemsTable, {
          id: itemsTable.id,
          db,
          hooks: {
            onAfterDelete: async () => {
              throw new Error("after-delete boom");
            },
          },
        })
      );
    });

    it("does not leave a phantom changelog entry for an uncommitted delete", async () => {
      const seeded = await seedOne();

      const res = await del(app, '/items/batch?filter=name=="alpha"');
      expect(res.status).toBe(500);

      // The DB transaction rolled back, so the row still exists.
      const rows = await db.select().from(itemsTable);
      expect(rows).toHaveLength(1);

      const entries = await changelogEntriesForResource();
      const phantom = entries.filter(
        (e) => e.type === "delete" && e.objectId === String(seeded.id)
      );
      expect(phantom).toHaveLength(0);
    });
  });

  describe("happy path still records to the changelog after commit", () => {
    beforeEach(() => {
      app.route(
        "/items",
        useResource(itemsTable, {
          id: itemsTable.id,
          db,
        })
      );
    });

    it("records exactly one entry per committed batch update", async () => {
      const seeded = await seedOne();

      const res = await patch(app, '/items/batch?filter=name=="alpha"', {
        value: 42,
      });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(itemsTable);
      expect((row as any).value).toBe(42);

      const entries = await changelogEntriesForResource();
      const updates = entries.filter(
        (e) => e.type === "update" && e.objectId === String(seeded.id)
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]!.object).toMatchObject({ value: 42 });
    });

    it("records exactly one entry per committed batch delete", async () => {
      const seeded = await seedOne();

      const res = await del(app, '/items/batch?filter=name=="alpha"');
      expect(res.status).toBe(200);

      const rows = await db.select().from(itemsTable);
      expect(rows).toHaveLength(0);

      const entries = await changelogEntriesForResource();
      const deletes = entries.filter(
        (e) => e.type === "delete" && e.objectId === String(seeded.id)
      );
      expect(deletes).toHaveLength(1);
    });
  });
});
