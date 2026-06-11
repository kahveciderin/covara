import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, patch } from "../helpers/hono";

const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default("user"),
  balance: integer("balance").notNull().default(0),
});

const makeApp = (opts: { writable?: string[]; strict?: boolean }) => {
  const tempDir = mkdtempSync(join(tmpdir(), "covara-wr-"));
  const libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
  const db = drizzle(libsqlClient);
  return libsqlClient
    .execute(
      `CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', balance INTEGER NOT NULL DEFAULT 0)`
    )
    .then(() => {
      const app = createTestApp({ user: { id: "u" } });
      app.route(
        "/accounts",
        useResource(accounts, {
          id: accounts.id,
          db,
          ...(opts.writable ? { fields: { writable: opts.writable } } : {}),
          ...(opts.strict ? { strictInput: true } : {}),
        })
      );
      return { app, db, libsqlClient, tempDir };
    });
};

describe("Writable-field enforcement (mass-assignment protection)", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterEach(() => {
    ctx?.libsqlClient.close();
    if (ctx) rmSync(ctx.tempDir, { recursive: true, force: true });
  });

  it("strips non-writable columns on create", async () => {
    ctx = await makeApp({ writable: ["id", "name"] });
    const res = await post(ctx.app, "/accounts", {
      id: "1",
      name: "Alice",
      role: "admin", // not writable -> must be ignored
      balance: 9999, // not writable -> must be ignored
    });
    expect(res.status).toBe(201);

    const row = await get(ctx.app, "/accounts/1");
    expect(row.body.name).toBe("Alice");
    expect(row.body.role).toBe("user"); // default, not the injected "admin"
    expect(row.body.balance).toBe(0); // default, not 9999
  });

  it("strips non-writable columns on update", async () => {
    ctx = await makeApp({ writable: ["id", "name"] });
    await post(ctx.app, "/accounts", { id: "1", name: "Alice" });

    await patch(ctx.app, "/accounts/1", { name: "Alice 2", role: "admin", balance: 500 });
    const row = await get(ctx.app, "/accounts/1");
    expect(row.body.name).toBe("Alice 2");
    expect(row.body.role).toBe("user");
    expect(row.body.balance).toBe(0);
  });
});

describe("Strict input (unknown-field rejection)", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterEach(() => {
    ctx?.libsqlClient.close();
    if (ctx) rmSync(ctx.tempDir, { recursive: true, force: true });
  });

  it("rejects unknown fields when strictInput is enabled", async () => {
    ctx = await makeApp({ strict: true });
    const res = await post(ctx.app, "/accounts", { id: "1", name: "Alice", bogus: "x" });
    expect(res.status).toBe(400);
  });

  it("accepts unknown fields by default (no strictInput)", async () => {
    ctx = await makeApp({});
    const res = await post(ctx.app, "/accounts", { id: "1", name: "Alice", bogus: "x" });
    expect(res.status).toBe(201);
  });
});
