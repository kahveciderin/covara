import { describe, it, expect, beforeEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createDrizzleSessionStore } from "@/auth/stores/drizzle";
import { defineInternalSchema } from "@/db/internal-schema";
import { authSessionsSqlite } from "@/db/internal-schema";
import { SessionData } from "@/auth/types";

const makeSession = (id: string, userId: string): SessionData => ({
  id,
  userId,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date(Date.now() + 60_000),
  data: { foo: "bar" },
});

describe("DrizzleSessionStore", () => {
  it("round-trips over a column-REMAPPED table via fieldMap", async () => {
    const sessions = sqliteTable("sessions", {
      id: text("id").primaryKey(),
      user_id: text("user_id").notNull(),
      created_at: integer("created_at", { mode: "timestamp" }).notNull(),
      expires: integer("expires", { mode: "timestamp" }).notNull(),
      blob: text("blob"),
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires INTEGER NOT NULL, blob TEXT)`
    );
    const db = drizzle(sqlite);
    const bundle = defineInternalSchema({
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
    const store = createDrizzleSessionStore({ db, resolver: bundle.sessions });

    await store.set("s1", makeSession("s1", "u1"), 60_000);
    await store.set("s2", makeSession("s2", "u1"), 60_000);
    await store.set("s3", makeSession("s3", "u2"), 60_000);

    const got = await store.get("s1");
    expect(got?.id).toBe("s1");
    expect(got?.userId).toBe("u1");
    expect(got?.data).toEqual({ foo: "bar" });
    expect(got?.createdAt).toBeInstanceOf(Date);

    const u1 = await store.getByUser("u1");
    expect(u1.map((s) => s.id).sort()).toEqual(["s1", "s2"]);

    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();

    expect(await store.deleteByUser("u2")).toBe(1);
    sqlite.close();
  });

  it("still accepts the legacy raw `table` option (back-compat shim)", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      `CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, data TEXT)`
    );
    const db = drizzle(sqlite);
    const store = createDrizzleSessionStore({
      db,
      table: authSessionsSqlite as never,
    });

    await store.set("s1", makeSession("s1", "u1"), 60_000);
    const got = await store.get("s1");
    expect(got?.id).toBe("s1");
    expect(got?.data).toEqual({ foo: "bar" });
    sqlite.close();
  });
});
