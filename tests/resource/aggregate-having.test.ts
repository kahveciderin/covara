import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post } from "../helpers/hono";

const sales = sqliteTable("sales", {
  id: text("id").primaryKey(),
  region: text("region").notNull(),
  amount: integer("amount").notNull(),
});

describe("Aggregation HAVING", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-having-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE sales (
        id TEXT PRIMARY KEY,
        region TEXT NOT NULL,
        amount INTEGER NOT NULL
      )
    `);
    app = createTestApp({ user: { id: "u" } });
    app.route("/sales", useResource(sales, { id: sales.id, db }));

    // east: 3 rows summing 60; west: 1 row summing 5; north: 2 rows summing 30
    const rows = [
      ["1", "east", 10], ["2", "east", 20], ["3", "east", 30],
      ["4", "west", 5],
      ["5", "north", 10], ["6", "north", 20],
    ] as const;
    for (const [id, region, amount] of rows) {
      await post(app, "/sales", { id, region, amount });
    }
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("filters groups by count with HAVING", async () => {
    const res = await get(app, "/sales/aggregate?groupBy=region&count=true&having=count>=2");
    const regions = res.body.groups.map((g: any) => g.key.region).sort();
    expect(regions).toEqual(["east", "north"]);
  });

  it("filters groups by an aggregate metric with HAVING", async () => {
    const res = await get(app, "/sales/aggregate?groupBy=region&sum=amount&having=sum_amount>50");
    const regions = res.body.groups.map((g: any) => g.key.region);
    expect(regions).toEqual(["east"]);
  });

  it("supports multiple HAVING conditions (AND)", async () => {
    const res = await get(
      app,
      "/sales/aggregate?groupBy=region&count=true&sum=amount&having=count>=2;sum_amount>40"
    );
    const regions = res.body.groups.map((g: any) => g.key.region);
    expect(regions).toEqual(["east"]);
  });

  it("rejects an unknown HAVING field", async () => {
    const res = await get(app, "/sales/aggregate?groupBy=region&count=true&having=bogus>1");
    expect(res.status).toBe(400);
  });
});
