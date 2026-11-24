import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  registerHandler,
  unregisterHandler,
  clearAllSubscriptions,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  invalidateSubscriptions,
  setPushAudience,
} from "@/resource/subscription";
import { createResourceFilter } from "@/resource/filter";
import { changelog } from "@/resource/changelog";
import { trackMutations } from "@/resource/track-mutations";
import { createMemoryKV, setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";

const items = sqliteTable("t_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  owner: text("owner"),
});

const filter = createResourceFilter(items, {});

const writer = () => {
  const events: { type: string; subscriptionId: string; [k: string]: unknown }[] = [];
  const w = {
    write: (data: string) => {
      for (const line of data.split("\n")) {
        if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      }
      return true;
    },
    close: () => {},
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    onClose: () => {},
  } as unknown as SSEWriter;
  return { w, events };
};

const bigUser = (id: string) => ({
  id,
  email: `${id}@example.com`,
  metadata: { permissions: Array.from({ length: 120 }, (_, k) => `resource-${k}:read`) },
});

describe("targeted pushes and smaller subscription records", () => {
  let memory: KVAdapter;
  let calls: { op: string; key: string }[];

  beforeEach(async () => {
    memory = createMemoryKV(`targeted-${crypto.randomUUID()}`);
    await memory.connect();
    calls = [];
    const counting = new Proxy(memory, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push({ op: String(prop), key: String(args[0]) });
          return value.apply(target, args);
        };
      },
    }) as KVAdapter;
    setGlobalKV(counting);
    await clearAllSubscriptions();
    await changelog.clear();
  });

  afterEach(async () => {
    setPushAudience("t_items", undefined);
    await clearAllSubscriptions();
    clearGlobalKV();
    await memory.disconnect();
  });

  const subscribe = async (n: number, opts: { include?: string } = {}) => {
    const subs: { id: string; events: ReturnType<typeof writer>["events"]; handlerId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const handlerId = `h-${i}-${crypto.randomUUID()}`;
      const { w, events } = writer();
      registerHandler(handlerId, w);
      const id = await createSubscription({
        resource: "t_items",
        filter: `id=="row-${i}"`,
        handlerId,
        authId: `user-${i}`,
        user: bigUser(`user-${i}`),
        include: opts.include,
      });
      subs.push({ id, events, handlerId });
    }
    return subs;
  };

  const wholeHashReads = () => calls.filter((c) => c.op === "hgetall" && c.key.includes("subs:byres:t_items")).length;
  const recordReads = () => calls.filter((c) => c.op === "hget" && c.key.includes("subs:byres:t_items")).length;

  it("a push with subscribers loads only those records", async () => {
    const subs = await subscribe(20);
    calls.length = 0;
    await pushUpdatesToSubscriptions("t_items", filter, [{ id: "row-0", name: "x" }], "id", new Map(), undefined, {
      subscribers: [subs[0].id],
    });
    expect(wholeHashReads()).toBe(0);
    expect(recordReads()).toBe(1);
    await vi.waitFor(() => expect(subs[0].events.some((e) => e.type === "added")).toBe(true));
    for (const s of subs.slice(1)) expect(s.events.filter((e) => e.type !== "connected")).toEqual([]);
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("an empty subscriber list loads nothing and delivers nothing", async () => {
    const subs = await subscribe(3);
    calls.length = 0;
    await pushInsertsToSubscriptions("t_items", filter, [{ id: "row-0", name: "x" }], "id", undefined, undefined, { subscribers: [] });
    await pushDeletesToSubscriptions("t_items", ["row-0"], undefined, { subscribers: [] });
    expect(wholeHashReads()).toBe(0);
    expect(recordReads()).toBe(0);
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("unknown and other resources' ids are ignored", async () => {
    const subs = await subscribe(2);
    await pushUpdatesToSubscriptions("t_items", filter, [{ id: "row-1", name: "x" }], "id", new Map(), undefined, {
      subscribers: ["nope:t_items", "x:other", subs[1].id],
    });
    await vi.waitFor(() => expect(subs[1].events.some((e) => e.type === "added")).toBe(true));
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("a targeted record whose lease expired is skipped and removed", async () => {
    const subs = await subscribe(1);
    await memory.hset("covara:subs:lease:t_items", subs[0].id, String(Date.now() - 1000));
    await pushUpdatesToSubscriptions("t_items", filter, [{ id: "row-0", name: "x" }], "id", new Map(), undefined, {
      subscribers: [subs[0].id],
    });
    expect(await memory.hget("covara:subs:byres:t_items", subs[0].id)).toBeNull();
    await unregisterHandler(subs[0].handlerId);
  });

  it("setPushAudience narrows every push on the resource and sees new and previous rows", async () => {
    const subs = await subscribe(5);
    const seen: unknown[] = [];
    setPushAudience("t_items", (change) => {
      seen.push(change);
      return [subs[3].id];
    });
    calls.length = 0;
    const previous = new Map([["row-3", { id: "row-3", name: "old" }]]);
    await pushUpdatesToSubscriptions("t_items", filter, [{ id: "row-3", name: "new" }], "id", previous);
    expect(wholeHashReads()).toBe(0);
    expect(seen).toEqual([
      { type: "update", resource: "t_items", ids: ["row-3"], rows: [{ id: "row-3", name: "new" }], previous: [{ id: "row-3", name: "old" }] },
    ]);
    await vi.waitFor(() => expect(subs[3].events.some((e) => e.type === "added")).toBe(true));

    await pushDeletesToSubscriptions("t_items", ["row-3"], [{ id: "row-3", name: "new" }]);
    expect(seen[1]).toEqual({ type: "delete", resource: "t_items", ids: ["row-3"], rows: [{ id: "row-3", name: "new" }], previous: undefined });
    await vi.waitFor(() => expect(subs[3].events.some((e) => e.type === "removed")).toBe(true));
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("an audience that returns undefined means everyone; explicit subscribers win over it", async () => {
    const subs = await subscribe(3);
    const audience = vi.fn(() => undefined);
    setPushAudience("t_items", audience);
    calls.length = 0;
    await pushInsertsToSubscriptions("t_items", filter, [{ id: "row-2", name: "x" }], "id");
    expect(wholeHashReads()).toBe(1);
    await vi.waitFor(() => expect(subs[2].events.some((e) => e.type === "added")).toBe(true));
    audience.mockClear();
    await pushInsertsToSubscriptions("t_items", filter, [{ id: "row-1", name: "x" }], "id", undefined, undefined, { subscribers: [subs[1].id] });
    expect(audience).not.toHaveBeenCalled();
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("an audience that throws falls back to everyone", async () => {
    const subs = await subscribe(2);
    setPushAudience("t_items", () => {
      throw new Error("boom");
    });
    await pushInsertsToSubscriptions("t_items", filter, [{ id: "row-1", name: "x" }], "id");
    await vi.waitFor(() => expect(subs[1].events.some((e) => e.type === "added")).toBe(true));
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  it("trackMutations({ audience }) narrows tracked writes", async () => {
    const client = createLibsqlClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE t_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT)`);
    const subs = await subscribe(4);
    const audience = vi.fn(() => [subs[2].id]);
    const db = trackMutations(drizzle(client), { t_items: { table: items, id: items.id, audience } });
    calls.length = 0;
    await db.insert(items).values({ id: "row-2", name: "x" }).returning();
    expect(audience).toHaveBeenCalledWith(expect.objectContaining({ type: "create", ids: ["row-2"] }));
    expect(wholeHashReads()).toBe(0);
    await vi.waitFor(() => expect(subs[2].events.some((e) => e.type === "added")).toBe(true));
    for (const s of subs) await unregisterHandler(s.handlerId);
  });

  describe("invalidateSubscriptions", () => {
    it("invalidates only the given subscriptions, loading only them, with no changelog entry", async () => {
      const subs = await subscribe(10);
      const seq = await changelog.getCurrentSequence();
      calls.length = 0;
      await invalidateSubscriptions("t_items", { subscriptionIds: [subs[4].id, subs[7].id], reason: "grades-published" });
      expect(await changelog.getCurrentSequence()).toBe(seq);
      expect(wholeHashReads()).toBe(0);
      expect(recordReads()).toBe(2);
      await vi.waitFor(() => expect(subs[7].events.some((e) => e.type === "invalidate")).toBe(true));
      expect(subs[4].events.find((e) => e.type === "invalidate")).toMatchObject({ reason: "grades-published" });
      for (const [i, s] of subs.entries()) {
        if (i !== 4 && i !== 7) expect(s.events.some((e) => e.type === "invalidate")).toBe(false);
      }
      for (const s of subs) await unregisterHandler(s.handlerId);
    });

    it("without ids invalidates every subscription on the resource, reading the hash once", async () => {
      const subs = await subscribe(5);
      const seq = await changelog.getCurrentSequence();
      calls.length = 0;
      await invalidateSubscriptions("t_items");
      expect(await changelog.getCurrentSequence()).toBe(seq);
      expect(wholeHashReads()).toBe(1);
      expect(recordReads()).toBe(0);
      for (const s of subs) await vi.waitFor(() => expect(s.events.some((e) => e.type === "invalidate")).toBe(true));
      for (const s of subs) await unregisterHandler(s.handlerId);
    });
  });

  describe("record size", () => {
    it("a subscription without include stores no user", async () => {
      const subs = await subscribe(1);
      const raw = (await memory.hget("covara:subs:byres:t_items", subs[0].id))!;
      expect(JSON.parse(raw).user).toBeNull();
      expect(raw).not.toContain("permissions");
      expect(raw.length).toBeLessThan(600);
      await unregisterHandler(subs[0].handlerId);
    });

    it("a subscription with include keeps the user for the relation loader", async () => {
      const subs = await subscribe(1, { include: "owner" });
      const raw = (await memory.hget("covara:subs:byres:t_items", subs[0].id))!;
      expect(JSON.parse(raw).user.id).toBe("user-0");
      const loader = vi.fn(async (rows: Record<string, unknown>[]) => rows);
      await pushInsertsToSubscriptions("t_items", filter, [{ id: "row-0", name: "x" }], "id", undefined, loader);
      expect(loader).toHaveBeenCalledWith(expect.any(Array), "owner", expect.objectContaining({ id: "user-0" }));
      await unregisterHandler(subs[0].handlerId);
    });
  });
});
