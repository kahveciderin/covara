import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { trackMutations } from "@/resource/track-mutations";
import { rsql } from "@/auth/rsql";
import { createMemoryKV, setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";
import { clearAllSubscriptions } from "@/resource/subscription";
import { createTestApp, request, SSECollector } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const parents = sqliteTable("jl_parents", {
  id: text("id").primaryKey(),
  departmentId: text("departmentId"),
});
const rows = sqliteTable("jl_rows", {
  id: text("id").primaryKey(),
  parentId: text("parentId").references(() => parents.id),
  title: text("title"),
  secret: text("secret"),
  deletedAt: text("deletedAt"),
});

const NEVER = 3_600_000;

describe.each(["memory KV", "no KV"])("live events under a relation-path scope (%s)", (mode) => {
  let t: TempDb;
  let kv: KVAdapter | undefined;
  const open: SSECollector[] = [];

  beforeEach(async () => {
    if (mode === "memory KV") {
      kv = createMemoryKV("join-live");
      await kv.connect();
      setGlobalKV(kv);
    }
    await clearAllSubscriptions();
    t = await openTempDb(`
      CREATE TABLE jl_parents (id TEXT PRIMARY KEY, departmentId TEXT);
      CREATE TABLE jl_rows (id TEXT PRIMARY KEY, parentId TEXT, title TEXT, secret TEXT, deletedAt TEXT);
      INSERT INTO jl_parents VALUES ('mine', 'd1'), ('theirs', 'd9');
      INSERT INTO jl_rows VALUES ('r1', 'mine', 'first', 's', NULL), ('r9', 'theirs', 'other', 's', NULL);
    `);
  });

  afterEach(async () => {
    for (const collector of open.splice(0)) collector.close();
    await clearAllSubscriptions();
    clearGlobalKV();
    await kv?.disconnect();
    kv = undefined;
    t.close();
  });

  const build = (extra: Record<string, unknown> = {}) => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/parents", useResource(parents, { id: parents.id, db: t.db }));
    app.route(
      "/rows",
      useResource(rows, {
        id: rows.id,
        db: t.db,
        sse: { scopeRecheckMs: NEVER },
        relations: {
          parent: { resource: "jl_parents", schema: parents, type: "belongsTo", foreignKey: rows.parentId, references: parents.id },
        },
        auth: {
          read: async () => rsql`parent.departmentId=in=${["d1", "d2"]}`,
          create: async () => rsql`*`,
          update: async () => rsql`*`,
          delete: async () => rsql`*`,
        },
        ...extra,
      } as any)
    );
    return app;
  };

  const subscribe = async (app: ReturnType<typeof createTestApp>, query = "") => {
    const { collector } = await SSECollector.connect(app, `/rows/subscribe${query}`);
    open.push(collector);
    await vi.waitFor(() => expect(collector.events.some((e) => e.data?.type === "existing")).toBe(true), { timeout: 3000 });
    const start = collector.events.length;
    return () =>
      collector.events
        .slice(start)
        .map((e) => e.data)
        .filter((d) => ["added", "changed", "removed", "invalidate"].includes(d?.type))
        .map((d) => [d.type, d.object?.id ?? d.objectId]);
  };

  const delivered = (events: () => unknown[], expected: unknown[]) =>
    vi.waitFor(() => expect(events()).toEqual(expected), { timeout: 3000 });

  it("delivers an insert in scope and not one outside it", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "POST", "/rows", { id: "r8", parentId: "theirs" });
    await request(app, "POST", "/rows", { id: "r2", parentId: "mine" });
    await delivered(events, [["added", "r2"]]);
  });

  it("delivers only the in-scope rows of a batch", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "POST", "/rows/batch", { items: [{ id: "r8", parentId: "theirs" }, { id: "r2", parentId: "mine" }] });
    await delivered(events, [["added", "r2"]]);
  });

  it("handles a batch larger than one query's id chunk", async () => {
    const app = build();
    const events = await subscribe(app);
    const items = Array.from({ length: 95 }, (_, i) => ({ id: `n${i}`, parentId: "mine" }));
    await request(app, "POST", "/rows/batch", { items });
    await delivered(events, items.map((i) => ["added", i.id]));
  });

  it("delivers a change to a row that stays in scope", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "PATCH", "/rows/r1", { title: "second" });
    await delivered(events, [["changed", "r1"]]);
  });

  it("delivers added and removed as a row crosses the scope", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "PATCH", "/rows/r9", { parentId: "mine" });
    await request(app, "PATCH", "/rows/r1", { parentId: "theirs" });
    await delivered(events, [["added", "r9"], ["removed", "r1"]]);
  });

  it("says nothing about a change that stays out of scope", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "PATCH", "/rows/r9", { title: "still theirs" });
    await request(app, "PATCH", "/rows/r1", { title: "mine" });
    await delivered(events, [["changed", "r1"]]);
  });

  it("combines the subscriber's filter with the scope", async () => {
    const app = build();
    const events = await subscribe(app, `?filter=${encodeURIComponent('title=="first"')}`);
    await request(app, "POST", "/rows", { id: "r2", parentId: "mine", title: "other" });
    await request(app, "POST", "/rows", { id: "r8", parentId: "theirs", title: "first" });
    await request(app, "POST", "/rows", { id: "r3", parentId: "mine", title: "first" });
    await delivered(events, [["added", "r3"]]);
  });

  it("delivers a delete", async () => {
    const app = build();
    const events = await subscribe(app);
    await request(app, "DELETE", "/rows/r1");
    await delivered(events, [["removed", "r1"]]);
  });

  it("treats a soft-deleted row as gone", async () => {
    const app = build({ softDelete: { field: rows.deletedAt } });
    const events = await subscribe(app);
    await request(app, "PATCH", "/rows/r1", { deletedAt: "now" });
    await delivered(events, [["removed", "r1"]]);
  });

  it("delivers tracked writes, including SQL update values", async () => {
    const app = build();
    const events = await subscribe(app);
    const db = trackMutations(t.db, { rows: { table: rows, id: rows.id } });
    await db.update(rows).set({ title: sql`'computed'` }).where(sql`${rows.id} = 'r1'`);
    await delivered(events, [["changed", "r1"]]);
  });

  it("delivers writes made in a tracked transaction", async () => {
    const app = build();
    const events = await subscribe(app);
    const db = trackMutations(t.db, { rows: { table: rows, id: rows.id } });
    await db.transaction(async (tx) => {
      await tx.insert(rows).values({ id: "r2", parentId: "mine" }).returning();
    });
    await delivered(events, [["added", "r2"]]);
  });

  it("masks the pushed row", async () => {
    const app = build({ fields: { readable: [rows.id, rows.title] } });
    const { collector } = await SSECollector.connect(app, "/rows/subscribe");
    open.push(collector);
    await vi.waitFor(() => expect(collector.events.length).toBeGreaterThan(1));
    await request(app, "PATCH", "/rows/r1", { title: "second" });
    await vi.waitFor(() => expect(collector.events.at(-1)?.data.type).toBe("changed"));
    expect(collector.events.at(-1)?.data.object).toEqual({ id: "r1", title: "second" });
  });

  it("does not retract a live insert that lands during a scope recheck", async () => {
    let stall: (() => void) | undefined;
    let stalled = false;
    let armed = false;
    const db = new Proxy(t.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "select" || !armed) return typeof value === "function" ? value.bind(target) : value;
        armed = false;
        return (...args: unknown[]) => {
          const builder = (value as any).apply(target, args);
          return {
            from: (table: unknown) => ({
              where: async (where: unknown) => {
                const snapshot = await builder.from(table).where(where);
                stalled = true;
                await new Promise<void>((resolve) => (stall = resolve));
                return snapshot;
              },
            }),
          };
        };
      },
    });
    const app = build({ db, sse: { scopeRecheckMs: 100 } });
    const events = await subscribe(app);
    armed = true;
    await vi.waitFor(() => expect(stalled).toBe(true), { timeout: 3000 });
    await request(app, "POST", "/rows", { id: "r2", parentId: "mine" });
    stall!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events()).not.toContainEqual(["removed", "r2"]);
    expect(events()).toContainEqual(["added", "r2"]);
  });

  it("invalidates, without failing the write, when the scope query fails", async () => {
    let failing = false;
    const db = new Proxy(t.db, {
      get(target, prop) {
        if (prop === "select" && failing) {
          return () => {
            throw new Error("db unavailable");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = build({ db });
    const events = await subscribe(app);
    failing = true;
    expect((await request(app, "POST", "/rows", { id: "r2", parentId: "mine" })).status).toBe(201);
    await delivered(events, [["invalidate", undefined]]);
  });
});
