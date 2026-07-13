import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { allScope, emptyScope } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createTestApp, get } from "../helpers/hono";

const secrets = sqliteTable("es_secrets", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
});

// End-to-end proof that an empty read scope fails closed on the HTTP read paths.
// Before the fix, combineScopes("", filter) dropped the scope and leaked rows.
describe("Empty read scope fails closed over HTTP", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    clearSchemaRegistry();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE es_secrets (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );
    db = drizzle(libsqlClient);
    await db.insert(secrets).values({ id: "s1", value: "top-secret" });
  });

  afterEach(() => libsqlClient.close());

  // Denied users resolve to an empty scope; allowed users see everything.
  const buildApp = (userId: string) => {
    const app = createTestApp({ user: { id: userId } });
    app.route(
      "/secrets",
      useResource(secrets, {
        id: secrets.id,
        db,
        auth: {
          read: async (u) => (u.id === "allowed" ? allScope() : emptyScope()),
        },
      })
    );
    return app;
  };

  it("returns no rows on list for a denied user", async () => {
    const res = await get(buildApp("denied"), "/secrets");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("ignores a targeted ?filter= from a denied user (no probing)", async () => {
    const res = await get(buildApp("denied"), '/secrets?filter=id=="s1"');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("returns 404 on get-by-id for a denied user", async () => {
    const res = await get(buildApp("denied"), "/secrets/s1");
    expect(res.status).toBe(404);
  });

  it("counts zero for a denied user", async () => {
    const res = await get(buildApp("denied"), "/secrets/count");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it("still serves rows to an allowed user (scope not over-applied)", async () => {
    const res = await get(buildApp("allowed"), "/secrets");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("s1");
  });
});
