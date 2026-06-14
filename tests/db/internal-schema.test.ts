import { describe, it, expect } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  defineInternalSchema,
  makeIdentityResolver,
  SESSION_KEYS,
  authSessionsSqlite,
} from "@/db/internal-schema";

describe("defineInternalSchema + TableResolver", () => {
  it("identity defaults map logical keys to the built-in table columns", () => {
    const bundle = defineInternalSchema();
    expect(bundle.dialect).toBe("sqlite");
    expect(bundle.managedExternally).toBe(false);
    for (const key of SESSION_KEYS) {
      expect(bundle.sessions.prop(key)).toBe(key);
      expect(bundle.sessions.dbName(key)).toBe(key);
      expect(bundle.sessions.has(key)).toBe(true);
    }
    // col() returns the actual Drizzle column object from the built-in table
    expect(bundle.sessions.col("id")).toBe(
      (authSessionsSqlite as Record<string, unknown>).id
    );
  });

  it("remaps logical keys to differently-named columns via fieldMap", () => {
    const sessions = sqliteTable("sessions", {
      id: text("id").primaryKey(),
      user_id: text("user_id").notNull(),
      created_at: integer("created_at", { mode: "timestamp" }).notNull(),
      expires: integer("expires", { mode: "timestamp" }).notNull(),
      blob: text("blob"),
    });

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

    expect(bundle.sessions.prop("userId")).toBe("user_id");
    expect(bundle.sessions.dbName("expiresAt")).toBe("expires");
    expect(bundle.sessions.col("createdAt")).toBe(
      (sessions as Record<string, unknown>).created_at
    );
    expect(bundle.sessions.has("data")).toBe(true);
  });

  it("treats an omitted optional column as absent", () => {
    const sessions = sqliteTable("sessions", {
      id: text("id").primaryKey(),
      userId: text("userId").notNull(),
      createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
      expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
      // no data column
    });
    const bundle = defineInternalSchema({ sessions: { table: sessions } });
    expect(bundle.sessions.has("data")).toBe(false);
    expect(bundle.sessions.has("id")).toBe(true);
  });

  it("throws when a required column is missing", () => {
    const broken = sqliteTable("broken", {
      id: text("id").primaryKey(),
      // missing userId/createdAt/expiresAt
    });
    expect(() =>
      defineInternalSchema({ sessions: { table: broken } })
    ).toThrow(/sessions\.userId/);
  });

  it("makeIdentityResolver works on a plain column-map object (shim path)", () => {
    const resolver = makeIdentityResolver(
      authSessionsSqlite as Record<string, unknown>,
      SESSION_KEYS
    );
    expect(resolver.prop("expiresAt")).toBe("expiresAt");
    expect(resolver.has("data")).toBe(true);
  });
});
