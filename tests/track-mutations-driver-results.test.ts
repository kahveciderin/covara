import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { pgTable, text, serial, integer } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { trackMutations } from "@/resource/track-mutations";
import { changelog } from "@/resource/changelog";
import * as subscriptions from "@/resource/subscription";

const items = pgTable("dr_items", {
  id: text("item_id").primaryKey(),
  name: text("name"),
  n: integer("n").notNull().default(0),
});
const autos = pgTable("dr_autos", { id: serial("id").primaryKey(), name: text("name") });

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE dr_items (item_id TEXT PRIMARY KEY, name TEXT, n INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE dr_autos (id SERIAL PRIMARY KEY, name TEXT);
  `);
}, 60_000);
afterAll(() => pg.close());

// postgres-js answers a statement without RETURNING with an EMPTY array that
// carries `count`; PGlite with an object. Both must be tracked the same way.
const drivers = {
  "postgres-js result": () =>
    drizzleProxy(async (text, params, method) => {
      const result = await pg.query<any>(text, params, { rowMode: method === "all" ? "array" : "object" });
      return { rows: method === "all" ? result.rows : (Object.assign([...result.rows], { count: result.affectedRows }) as any) };
    }),
  "pglite result": () => drizzlePglite(pg),
};

describe.each(Object.entries(drivers))("mutation tracking with a %s", (_name, connect) => {
  let t: any;

  beforeEach(async () => {
    await pg.exec("TRUNCATE dr_items; TRUNCATE dr_autos; INSERT INTO dr_items VALUES ('a','A',1),('b','B',2);");
    await changelog.clear();
    vi.restoreAllMocks();
    t = trackMutations(connect() as any, {
      dr_items: { table: items, id: items.id },
      dr_autos: { table: autos, id: autos.id },
    });
  });

  const entries = async () => [
    ...(await changelog.getEntriesSince("dr_items", 0)),
    ...(await changelog.getEntriesSince("dr_autos", 0)),
  ];
  const summary = async () => (await entries()).map((e) => `${e.type}:${e.objectId}`);

  it("insert records the stored row, defaults included, and pushes it", async () => {
    const push = vi.spyOn(subscriptions, "pushInsertsToSubscriptions");
    await t.insert(items).values({ id: "c", name: "C" });
    expect(await summary()).toEqual(["create:c"]);
    expect((await entries())[0].object).toEqual({ id: "c", name: "C", n: 0 });
    expect(push).toHaveBeenCalledWith("dr_items", expect.anything(), [{ id: "c", name: "C", n: 0 }], "id");
  });

  it("insert of many rows, more than one id chunk", async () => {
    await t.insert(items).values(Array.from({ length: 200 }, (_, i) => ({ id: `n${i}` })));
    expect(await summary()).toHaveLength(200);
  }, 20_000);

  it("insert with a database-generated id invalidates", async () => {
    const invalidate = vi.spyOn(subscriptions, "invalidateResourceSubscriptions");
    await t.insert(autos).values({ name: "x" });
    expect(await summary()).toEqual(["create:*"]);
    expect(invalidate).toHaveBeenCalledWith("dr_autos", expect.any(String));
  });

  it("insert with a SQL id invalidates", async () => {
    await t.insert(items).values({ id: sql`'computed'` });
    expect(await summary()).toEqual(["create:*"]);
  });

  it("insert returning() keys on the renamed primary key", async () => {
    await t.insert(items).values({ id: "c" }).returning();
    expect(await summary()).toEqual(["create:c"]);
  });

  it("insert returning(fields) records the full row", async () => {
    const result = await t.insert(items).values({ id: "c" }).returning({ name: items.name });
    expect(result).toEqual([{ name: null }]);
    expect((await entries())[0].object).toEqual({ id: "c", name: null, n: 0 });
  });

  it("returns the driver's own result untouched", async () => {
    const result = await t.insert(items).values({ id: "c" });
    expect(result.count ?? result.affectedRows).toBe(1);
  });

  it("onConflictDoNothing that did nothing records nothing", async () => {
    await t.insert(items).values({ id: "a" }).onConflictDoNothing();
    expect(await summary()).toEqual([]);
  });

  it("onConflictDoNothing that inserted invalidates", async () => {
    await t.insert(items).values({ id: "c" }).onConflictDoNothing();
    expect(await summary()).toEqual(["create:*"]);
  });

  it("onConflictDoUpdate invalidates", async () => {
    await t.insert(items).values({ id: "a" }).onConflictDoUpdate({ target: items.id, set: { name: "Z" } });
    expect(await summary()).toEqual(["create:*"]);
  });

  it("update records and pushes the row", async () => {
    const push = vi.spyOn(subscriptions, "pushUpdatesToSubscriptions");
    await t.update(items).set({ name: "Z" }).where(eq(items.id, "a"));
    const [entry] = await entries();
    expect(entry).toMatchObject({ type: "update", objectId: "a", object: { name: "Z" }, previousObject: { name: "A" } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("update with a SQL value records the computed value", async () => {
    await t.update(items).set({ n: sql`${items.n} + 1` }).where(eq(items.id, "a"));
    expect((await entries())[0].object).toMatchObject({ id: "a", n: 2 });
  });

  it("update that changes the column it filtered on", async () => {
    await t.update(items).set({ name: "Z" }).where(eq(items.name, "A"));
    expect((await entries())[0].object).toMatchObject({ id: "a", name: "Z" });
  });

  it("update that changes the primary key", async () => {
    await t.update(items).set({ id: "z" }).where(eq(items.id, "a"));
    expect(await summary()).toEqual(["update:z"]);
  });

  it("update of nothing records nothing", async () => {
    await t.update(items).set({ name: "Z" }).where(eq(items.id, "missing"));
    expect(await summary()).toEqual([]);
  });

  it("update returning(fields) records the full row", async () => {
    await t.update(items).set({ name: "Z" }).where(eq(items.id, "a")).returning({ name: items.name });
    expect((await entries())[0].object).toEqual({ id: "a", name: "Z", n: 1 });
  });

  it("update without a where invalidates", async () => {
    await t.update(items).set({ name: "Z" });
    expect(await summary()).toEqual(["update:*"]);
  });

  it("update without previous-state capture invalidates", async () => {
    const db = trackMutations(connect() as any, { i: { table: items, id: items.id } }, { capturePreviousState: false }) as any;
    await db.update(items).set({ name: "Z" }).where(eq(items.id, "a"));
    expect(await summary()).toEqual(["update:*"]);
  });

  it.each(["execute", "catch", "finally"])("update through .%s()", async (method) => {
    const query = t.update(items).set({ name: "Z" }).where(eq(items.id, "a"));
    await (method === "catch" ? query.catch(() => {}) : method === "finally" ? query.finally(() => {}) : query.execute());
    expect(await summary()).toEqual(["update:a"]);
  });

  it("delete keys on the renamed primary key", async () => {
    await t.delete(items).where(eq(items.id, "a"));
    expect(await summary()).toEqual(["delete:a"]);
  });

  it("delete without a where invalidates", async () => {
    await t.delete(items);
    expect(await summary()).toEqual(["delete:*"]);
  });

  it("delete without a where of an empty table records nothing", async () => {
    await pg.exec("TRUNCATE dr_items");
    await t.delete(items);
    expect(await summary()).toEqual([]);
  });

  it("a failed write records nothing", async () => {
    await expect(t.insert(items).values({ id: "a" })).rejects.toThrow();
    expect(await summary()).toEqual([]);
  });

  it("raw SQL invalidates subscribers", async () => {
    const invalidate = vi.spyOn(subscriptions, "invalidateResourceSubscriptions");
    await t.execute(sql.raw("UPDATE dr_items SET name='R' WHERE item_id='a'"));
    expect(await summary()).toEqual(["update:*"]);
    expect(invalidate).toHaveBeenCalledWith("dr_items", expect.any(String));
  });

  it("pushToSubscriptions:false records without pushing", async () => {
    const invalidate = vi.spyOn(subscriptions, "invalidateResourceSubscriptions");
    const db = trackMutations(connect() as any, { i: { table: items, id: items.id } }, { pushToSubscriptions: false }) as any;
    await db.delete(items);
    expect(await summary()).toEqual(["delete:*"]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
