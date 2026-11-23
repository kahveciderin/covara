import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createCovara } from "@/server/app";
import { abuseProtection, clearGlobalAbuseProtection, type BudgetConfig } from "@/abuse/config";
import { clearBudgetMemoryForTests } from "@/abuse/budget";
import { clearGlobalKV } from "@/kv";

const docs = sqliteTable("docs", { id: text("id").primaryKey(), title: text("title").notNull() });
const notes = sqliteTable("notes", { id: text("id").primaryKey(), title: text("title").notNull() });

const build = (budget: Omit<BudgetConfig, "enabled">) => {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  const db = drizzle(sqlite);
  const app = createCovara({
    abuseProtection: abuseProtection({ budget: { enabled: true, ...budget }, pow: { enabled: false } }),
    securityHeaders: false,
  });
  const auth = { public: { read: true, create: true } };
  app.resource("/docs", docs, { db, id: docs.id, auth, cost: { read: 1, create: 1 } });
  app.resource("/notes", notes, { db, id: notes.id, auth, cost: { read: 1, create: 1 } });
  let n = 0;
  const create = (path: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `r${++n}`, title: "t" }),
    });
  const read = (path: string) => app.request(path);
  return { create, read };
};

beforeEach(() => {
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
});

describe("budget classes per operation", () => {
  it("classify gets the operation, so reads and writes of one client have separate buckets", async () => {
    const seen: unknown[] = [];
    const { create, read } = build({
      classify: (_c, info) => {
        seen.push(info);
        return info?.operation === "read" ? "reads" : "anonymous";
      },
      classes: { anonymous: { capacity: 2, refillPerMinute: 0 }, reads: { capacity: 5, refillPerMinute: 0 } },
    });
    expect((await create("/api/docs")).status).toBe(201);
    expect((await create("/api/docs")).status).toBe(201);
    expect((await create("/api/docs")).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await read("/api/docs")).status).toBe(200);
    expect((await read("/api/docs")).status).toBe(429);
    expect(seen).toContainEqual({ operation: "create", resource: "docs" });
    expect(seen).toContainEqual({ operation: "read", resource: "docs" });
  });

  it("keyGenerator gets the resource, so each resource can have its own bucket", async () => {
    const { create } = build({
      keyGenerator: (_c, className, info) => `${className}:${info?.resource}`,
      classes: { anonymous: { capacity: 1, refillPerMinute: 0 } },
    });
    expect((await create("/api/docs")).status).toBe(201);
    expect((await create("/api/docs")).status).toBe(429);
    expect((await create("/api/notes")).status).toBe(201);
  });

  it("a two-argument classify still works", async () => {
    const { create } = build({
      classify: () => "anonymous",
      classes: { anonymous: { capacity: 1, refillPerMinute: 0 } },
    });
    expect((await create("/api/docs")).status).toBe(201);
    expect((await create("/api/notes")).status).toBe(429);
  });

  it("a class with no config leaves the operation unmetered", async () => {
    const { read } = build({
      classify: (_c, info) => (info?.operation === "read" ? "unmetered" : "anonymous"),
      classes: { anonymous: { capacity: 1, refillPerMinute: 0 } },
    });
    for (let i = 0; i < 5; i++) expect((await read("/api/docs")).status).toBe(200);
  });
});
