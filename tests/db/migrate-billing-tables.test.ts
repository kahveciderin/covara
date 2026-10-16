import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";
import { migrateInternal } from "@/db/migrate";
import { defineInternalSchema } from "@/db/internal-schema";

const entryInsert = (id: string, seq: number, key: string | null): string =>
  `INSERT INTO billing_credit_entries (id, account, seq, kind, delta, balanceAfter, idempotencyKey, createdAt) VALUES ('${id}','acct',${seq},'grant',1,1,${key === null ? "NULL" : `'${key}'`},0)`;

describe("migrateInternal — billing internal tables", () => {
  it("creates the credits + subscription tables with their unique indexes on SQLite", async () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    const summary = await migrateInternal(db);
    expect(summary.tables).toEqual(
      expect.arrayContaining(["billing_credit_entries", "billing_credit_balances", "billing_subscriptions"])
    );
    await client.execute(entryInsert("a", 1, "k"));
    await expect(client.execute(entryInsert("b", 1, null))).rejects.toThrow();
    await expect(client.execute(entryInsert("c", 2, "k"))).rejects.toThrow();
    await client.execute(entryInsert("d", 3, null));
    await client.execute(entryInsert("e", 4, null));
    client.close();
  });

  it("creates them on Postgres and stays idempotent", async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migrateInternal(db);
    await migrateInternal(db);
    const result = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'billing_%' ORDER BY table_name"
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      "billing_credit_balances",
      "billing_credit_entries",
      "billing_subscriptions",
    ]);
    await pglite.close();
  });

  it("generates BIGINT columns and the ledger's unique indexes for overridden Postgres tables", async () => {
    const entries = pgTable("ledger_entries", {
      id: text("id").primaryKey(),
      owner: text("owner").notNull(),
      seq: bigint("seq", { mode: "number" }).notNull(),
      kind: text("kind").notNull(),
      delta: bigint("delta", { mode: "number" }).notNull(),
      balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
      idempotencyKey: text("idem"),
      createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    });
    const schema = defineInternalSchema({
      dialect: "postgresql",
      creditEntries: { table: entries, fieldMap: { account: "owner" } },
    });
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migrateInternal(db, { schema });
    const cols = await pglite.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ledger_entries'"
    );
    expect(cols.rows.find((c) => c.column_name === "delta")?.data_type).toBe("bigint");
    const idx = await pglite.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'ledger_entries' ORDER BY indexname"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(["ledger_entries_account_idem_uq", "ledger_entries_account_seq_uq"])
    );
    await pglite.close();
  });

  it("managedExternally lists the billing tables without running DDL", async () => {
    const summary = await migrateInternal(drizzleLibsql(createClient({ url: ":memory:" })), {
      schema: defineInternalSchema({ managedExternally: true }),
    });
    expect(summary.statements).toBe(0);
    expect(summary.tables).toEqual(
      expect.arrayContaining(["billing_credit_entries", "billing_subscriptions"])
    );
  });

  it("rejects an overridden credit entries table missing a required column", () => {
    const broken = sqliteTable("broken_entries", { id: sqliteText("id").primaryKey() });
    expect(() => defineInternalSchema({ creditEntries: { table: broken } })).toThrow(
      /creditEntries\.account/
    );
  });
});
