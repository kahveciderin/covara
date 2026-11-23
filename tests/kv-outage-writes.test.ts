import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { createMemoryKV, setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";
import { trackMutations } from "@/resource/track-mutations";
import { useResource } from "@/resource/hook";
import { allScope } from "@/auth/rsql";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";
import { openTempDb, type TempDb } from "./helpers/temp-db";

const notes = sqliteTable("outage_notes", { id: text("id").primaryKey(), body: text("body") });

const failingKV = (kv: KVAdapter, isDown: () => boolean): KVAdapter =>
  new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (isDown() && prop !== "disconnect") return Promise.reject(new Error("KV unreachable"));
        return value.apply(target, args);
      };
    },
  });

describe("a KV outage after a committed write", () => {
  let temp: TempDb;
  let down: boolean;
  let logs: LogRecord[];
  const previousLogger = getLogger();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(async () => {
    temp = await openTempDb("CREATE TABLE outage_notes (id TEXT PRIMARY KEY, body TEXT);");
    down = false;
    logs = [];
    unhandled.length = 0;
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    const kv = createMemoryKV("outage");
    await kv.connect();
    setGlobalKV(failingKV(kv, () => down));
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    setLogger(previousLogger);
    clearGlobalKV();
    temp.close();
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));
  const stored = async () => temp.db.select().from(notes);

  it("a tracked insert, update and delete resolve and log the failure", async () => {
    const t = trackMutations(temp.db as any, { outage_notes: { table: notes, id: notes.id } });
    down = true;
    await expect(t.insert(notes).values({ id: "a", body: "one" })).resolves.toBeDefined();
    await expect(t.update(notes).set({ body: "two" }).where(eq(notes.id, "a"))).resolves.toBeDefined();
    expect(await stored()).toEqual([{ id: "a", body: "two" }]);
    await expect(t.delete(notes).where(eq(notes.id, "a"))).resolves.toBeDefined();
    expect(await stored()).toEqual([]);
    await settle();
    expect(logs.filter((l) => l.level === "error").length).toBeGreaterThanOrEqual(3);
    expect(unhandled).toEqual([]);
  });

  it("a tracked transaction resolves once committed", async () => {
    const t = trackMutations(temp.db as any, { outage_notes: { table: notes, id: notes.id } });
    down = true;
    await expect(
      t.transaction(async (tx: any) => {
        await tx.insert(notes).values({ id: "b", body: "in tx" });
        return "done";
      })
    ).resolves.toBe("done");
    expect(await stored()).toEqual([{ id: "b", body: "in tx" }]);
  });

  it("the REST routes answer with the committed result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = new Hono();
    app.use("*", async (c, next) => (c.set("user", { id: "u1" } as any), next()));
    app.route(
      "/notes",
      useResource(notes, {
        id: notes.id,
        db: temp.db as any,
        auth: { read: allScope, create: allScope, update: allScope, delete: allScope, subscribe: allScope },
      } as any)
    );
    down = true;
    const json = { "content-type": "application/json" };
    const created = await app.request("/notes", { method: "POST", headers: json, body: JSON.stringify({ id: "c", body: "x" }) });
    expect(created.status).toBe(201);
    const patched = await app.request("/notes/c", { method: "PATCH", headers: json, body: JSON.stringify({ body: "y" }) });
    expect(patched.status).toBe(200);
    const put = await app.request("/notes/c", { method: "PUT", headers: json, body: JSON.stringify({ id: "c", body: "z" }) });
    expect(put.status).toBe(200);
    const batch = await app.request("/notes/batch", { method: "POST", headers: json, body: JSON.stringify({ items: [{ id: "d", body: "d" }] }) });
    expect(batch.status).toBe(200);
    const batchPatch = await app.request("/notes/batch?filter=id==%22d%22", { method: "PATCH", headers: json, body: JSON.stringify({ body: "dd" }) });
    expect(batchPatch.status).toBe(200);
    const batchDelete = await app.request("/notes/batch?filter=id==%22d%22", { method: "DELETE" });
    expect(batchDelete.status).toBe(200);
    const deleted = await app.request("/notes/c", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await stored()).toEqual([]);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
