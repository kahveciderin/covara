import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { createTestApp, post } from "../helpers/hono";

const items = sqliteTable("gf_items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id").notNull(),
});

describe("generatedFields validation ordering hint", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE gf_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL)`
    );
    db = drizzle(libsqlClient);
  });

  afterEach(() => libsqlClient.close());

  it("hints about generatedFields when a required column is missing", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/items",
      useResource(items, {
        id: items.id,
        db,
        hooks: {
          onBeforeCreate: async (_ctx, data: any) => ({ ...data, ownerId: "u1" }),
        },
      })
    );

    const res = await post(app, "/items", { id: "a", title: "Hi" });

    expect(res.status).toBe(400);
    const ownerErr = res.body.errors?.find((e: any) => e.field === "ownerId");
    expect(ownerErr).toBeDefined();
    expect(ownerErr.message).toContain("generatedFields");
  });

  it("accepts the create once the hook-filled column is declared generated", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/items",
      useResource(items, {
        id: items.id,
        db,
        generatedFields: ["ownerId"],
        hooks: {
          onBeforeCreate: async (_ctx, data: any) => ({ ...data, ownerId: "u1" }),
        },
      })
    );

    const res = await post(app, "/items", { id: "b", title: "Hi" });

    expect(res.status).toBe(201);
    const rows = await db.select().from(items);
    expect(rows[0].ownerId).toBe("u1");
  });
});
