import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createTestApp, get, post, del } from "../helpers/hono";

// Columns whose DB name differs from their JS property. Field policies
// (writable/readable/generatedFields/softDelete) must be compared in property
// space — the space of request bodies and drizzle rows — not DB-name space.
const orgs = sqliteTable("cnw_orgs", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  ownerId: text("owner_id").notNull(),
  secretKey: text("secret_key"),
  deletedAt: text("deleted_at"),
});

describe("column name vs property in the write/read/field-policy paths", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    clearSchemaRegistry();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE cnw_orgs (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, owner_id TEXT NOT NULL, secret_key TEXT, deleted_at TEXT)`
    );
    db = drizzle(libsqlClient);
  });

  afterEach(() => libsqlClient.close());

  it("persists writable renamed columns and strips only non-writable ones", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/orgs",
      useResource(orgs, {
        id: orgs.id,
        db,
        fields: { writable: [orgs.displayName, orgs.ownerId] },
      })
    );

    const res = await post(app, "/orgs", {
      id: "o1",
      displayName: "Acme",
      ownerId: "u1",
      secretKey: "should-be-stripped",
    });
    expect(res.status).toBe(201);

    const rows = await db.select().from(orgs);
    expect(rows).toHaveLength(1);
    // Writable renamed columns are persisted (previously stripped -> NOT NULL / null).
    expect(rows[0].displayName).toBe("Acme");
    expect(rows[0].ownerId).toBe("u1");
    // Non-writable column is stripped (mass-assignment protection still works).
    expect(rows[0].secretKey).toBeNull();
  });

  it("masks reads by the property-keyed readable allowlist", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/orgs",
      useResource(orgs, {
        id: orgs.id,
        db,
        fields: { readable: [orgs.id, orgs.displayName] },
      })
    );

    await post(app, "/orgs", { id: "o1", displayName: "Acme", ownerId: "u1", secretKey: "s" });
    const res = await get(app, "/orgs/o1");
    expect(res.status).toBe(200);
    // Readable columns are returned (previously all masked because the set held DB names).
    expect(res.body.displayName).toBe("Acme");
    expect(res.body.id).toBe("o1");
    // Non-readable columns are masked out.
    expect("secretKey" in res.body).toBe(false);
    expect("ownerId" in res.body).toBe(false);
  });

  it("treats a hook-filled renamed column as generated", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/orgs",
      useResource(orgs, {
        id: orgs.id,
        db,
        generatedFields: [orgs.ownerId],
        hooks: {
          onBeforeCreate: async (_ctx, data: any) => ({ ...data, ownerId: "u1" }),
        },
      })
    );

    // ownerId omitted by the client; the hook fills it. generatedFields must make
    // it optional in validation despite the snake_case DB name.
    const res = await post(app, "/orgs", { id: "o1", displayName: "Acme" });
    expect(res.status).toBe(201);
    const rows = await db.select().from(orgs);
    expect(rows[0].ownerId).toBe("u1");
  });

  it("soft-deletes via a renamed marker column", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/orgs",
      useResource(orgs, {
        id: orgs.id,
        db,
        softDelete: { field: orgs.deletedAt },
      })
    );

    await post(app, "/orgs", { id: "o1", displayName: "Acme", ownerId: "u1" });
    const delRes = await del(app, "/orgs/o1");
    expect(delRes.status).toBe(204);

    // Hidden from reads...
    expect((await get(app, "/orgs/o1")).status).toBe(404);
    // ...but the marker column is set (soft, not hard, delete).
    const rows = await db.select().from(orgs);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();
  });
});
