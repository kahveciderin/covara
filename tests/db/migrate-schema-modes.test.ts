import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { migrateInternal } from "@/db/migrate";
import { defineInternalSchema } from "@/db/internal-schema";

const makeSqlite = () => drizzleLibsql(createClient({ url: ":memory:" }));

describe("migrateInternal schema modes", () => {
  let db: ReturnType<typeof makeSqlite>;
  beforeEach(() => {
    db = makeSqlite();
  });

  it("mode (a): no schema runs the built-in DDL", async () => {
    const summary = await migrateInternal(db);
    expect(summary.statements).toBeGreaterThan(0);
    expect(summary.skipped).toBeUndefined();
  });

  it("mode (b): managedExternally is a no-op", async () => {
    const schema = defineInternalSchema({ managedExternally: true });
    const summary = await migrateInternal(db, { schema });
    expect(summary.statements).toBe(0);
    expect(summary.skipped).toBe(true);
  });

  it("mode (c): generates DDL for an overridden single-PK table", async () => {
    const sessions = sqliteTable("my_sessions", {
      id: text("id").primaryKey(),
      user_id: text("user_id").notNull(),
      created_at: integer("created_at", { mode: "timestamp" }).notNull(),
      expires: integer("expires", { mode: "timestamp" }).notNull(),
      blob: text("blob"),
    });
    const schema = defineInternalSchema({
      sessions: {
        table: sessions,
        fieldMap: {
          userId: "user_id",
          createdAt: "created_at",
          expiresAt: "expires",
          data: "blob",
        },
      },
    });
    const summary = await migrateInternal(db, { schema });
    expect(summary.tables).toContain("my_sessions");
    // The generated table is usable.
    await db.run(
      sql.raw(
        `INSERT INTO my_sessions (id, user_id, created_at, expires) VALUES ('s1','u1',0,0)`
      )
    );
    const rows = await db.all(sql.raw(`SELECT id FROM my_sessions`));
    expect(rows.length).toBe(1);
  });

  it("mode (c): throws for an overridden compound-PK table", async () => {
    const verification = sqliteTable("my_verif", {
      identifier: text("identifier").notNull(),
      token: text("token").notNull(),
      expires: integer("expires", { mode: "timestamp" }).notNull(),
    });
    // No single-column primary key -> compound/missing PK -> must use drizzle-kit.
    const schema = defineInternalSchema({
      verificationTokens: { table: verification },
    });
    await expect(migrateInternal(db, { schema })).rejects.toThrow(
      /compound or missing primary key/
    );
  });
});
