import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { migrateInternal, autoMigrate } from "@/db/migrate";
import { defineInternalSchema } from "@/db/internal-schema";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

const APP_TABLE = "CREATE TABLE billing_subscriptions (id TEXT PRIMARY KEY, user_id TEXT, polar_customer_id TEXT)";

describe("an app table that shares an internal table's name", () => {
  let logs: LogRecord[];
  const previous = getLogger();

  beforeEach(() => {
    logs = [];
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
  });
  afterEach(() => setLogger(previous));

  const warnings = () => logs.filter((l) => l.level === "warn");

  it("is left alone on SQLite, with a warning, and the other tables are created", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(APP_TABLE);
    const summary = await autoMigrate(drizzleLibsql(client));
    expect(summary.conflicts).toEqual(["billing_subscriptions"]);
    expect(summary.tables).not.toContain("billing_subscriptions");
    expect(summary.tables).toContain("billing_credit_entries");
    const columns = (await client.execute("PRAGMA table_info(billing_subscriptions)")).rows.map((r) => r.name);
    expect(columns).toEqual(["id", "user_id", "polar_customer_id"]);
    expect(warnings()).toHaveLength(1);
    expect(String(warnings()[0].msg)).toMatch(/billing_subscriptions/);
    expect(JSON.stringify(warnings()[0])).toMatch(/defineInternalSchema/);
    client.close();
  });

  it("is left alone on Postgres", async () => {
    const pglite = new PGlite();
    await pglite.exec(APP_TABLE);
    const summary = await migrateInternal(drizzlePglite(pglite));
    expect(summary.conflicts).toEqual(["billing_subscriptions"]);
    const { rows } = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'auth_sessions'"
    );
    expect(rows).toHaveLength(1);
    await pglite.close();
  });

  it("a covara-shaped table from an earlier run is not a conflict", async () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    await migrateInternal(db);
    const summary = await migrateInternal(db);
    expect(summary.conflicts ?? []).toEqual([]);
    expect(warnings()).toHaveLength(0);
    client.close();
  });

  it("an override with a free name is created next to the app's table", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(APP_TABLE);
    const ours = sqliteTable("covara_billing_subscriptions", {
      id: text("id").primaryKey(),
      provider: text("provider").notNull(),
      customerId: text("customerId").notNull(),
      account: text("account"),
      status: text("status").notNull(),
      priceId: text("priceId"),
      productId: text("productId"),
      quantity: integer("quantity"),
      currentPeriodStart: integer("currentPeriodStart"),
      currentPeriodEnd: integer("currentPeriodEnd"),
      cancelAtPeriodEnd: integer("cancelAtPeriodEnd"),
      trialEndsAt: integer("trialEndsAt"),
      metadata: text("metadata"),
      source: text("source"),
      updatedAt: integer("updatedAt").notNull(),
    });
    const schema = defineInternalSchema({ dialect: "sqlite", billingSubscriptions: { table: ours } });
    const summary = await migrateInternal(drizzleLibsql(client), { schema });
    expect(summary.conflicts ?? []).toEqual([]);
    expect(summary.tables).toContain("covara_billing_subscriptions");
    client.close();
  });
});
