import { describe, it, expect } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { defineInternalSchema } from "@/db/internal-schema";
import { DrizzlePasskeyStore } from "@/auth/stores/drizzle-passkeys";

const sessions = sqliteTable("my_sessions", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  createdAt: text("createdAt").notNull(),
  expiresAt: text("expiresAt").notNull(),
  data: text("data"),
});
const pgSessions = pgTable("my_sessions", {
  id: pgText("id").primaryKey(),
  userId: pgText("userId").notNull(),
  createdAt: pgText("createdAt").notNull(),
  expiresAt: pgText("expiresAt").notNull(),
  data: pgText("data"),
});

describe("defineInternalSchema accepts plain Drizzle tables", () => {
  it("SQLite and Postgres tables need no cast", () => {
    expect(defineInternalSchema({ sessions: { table: sessions } }).sessions.table).toBe(sessions);
    expect(defineInternalSchema({ dialect: "postgresql", sessions: { table: pgSessions } }).sessions.table).toBe(pgSessions);
  });
});

const passkeys = sqliteTable("my_passkeys", { id: text("id").primaryKey() });
export const passkeyStoreOptions: ConstructorParameters<typeof DrizzlePasskeyStore>[0] = { db: {} as never, table: passkeys };
