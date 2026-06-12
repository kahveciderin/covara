import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import {
  registerAggregateWatcher,
  notifyAggregateWatchers,
  getAggregateWatcherCount,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  clearAllSubscriptions,
} from "@/resource/subscription";
import { createResourceFilter } from "@/resource/filter";
import { canonicalizeAggregation } from "@/resource/query";
import { createTestApp, SSECollector } from "../helpers/hono";

const items = sqliteTable("agg_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status").notNull(),
  amount: integer("amount").notNull(),
});

describe("aggregate watcher registry", () => {
  beforeEach(async () => {
    await clearAllSubscriptions();
  });

  it("registers and unregisters watchers", () => {
    let fired = 0;
    const unwatch = registerAggregateWatcher("agg_items", () => {
      fired++;
    });
    expect(getAggregateWatcherCount("agg_items")).toBe(1);

    void notifyAggregateWatchers("agg_items");
    expect(fired).toBe(1);

    unwatch();
    expect(getAggregateWatcherCount("agg_items")).toBe(0);

    void notifyAggregateWatchers("agg_items");
    expect(fired).toBe(1);
  });

  it("only notifies watchers for the matching resource", () => {
    let a = 0;
    let b = 0;
    registerAggregateWatcher("res_a", () => a++);
    registerAggregateWatcher("res_b", () => b++);

    void notifyAggregateWatchers("res_a");
    expect(a).toBe(1);
    expect(b).toBe(0);
  });

  it("a failing watcher does not break notification of the others", () => {
    let good = 0;
    registerAggregateWatcher("res_c", () => {
      throw new Error("boom");
    });
    registerAggregateWatcher("res_c", () => good++);
    expect(() => void notifyAggregateWatchers("res_c")).not.toThrow();
    expect(good).toBe(1);
  });

  it("is triggered when a mutation is pushed to subscriptions", async () => {
    let fired = 0;
    registerAggregateWatcher("agg_items", () => fired++);
    const filterer = createResourceFilter(items, {});
    await pushInsertsToSubscriptions(
      "agg_items",
      filterer,
      [{ id: 1, name: "x", status: "active", amount: 5 }],
      "id"
    );
    expect(fired).toBe(1);
  });

  it("passes the changed rows to watchers so they can scope-skip", () => {
    let received: Record<string, unknown>[] | undefined;
    registerAggregateWatcher("agg_items", (changed) => {
      received = changed;
    });
    void notifyAggregateWatchers("agg_items", [{ id: 7, status: "active" }]);
    expect(received).toEqual([{ id: 7, status: "active" }]);
  });

  it("forwards inserted rows to watchers (so out-of-scope inserts can be skipped)", async () => {
    let received: Record<string, unknown>[] | undefined;
    registerAggregateWatcher("agg_items", (changed) => {
      received = changed;
    });
    const filterer = createResourceFilter(items, {});
    const row = { id: 2, name: "y", status: "done", amount: 1 };
    await pushInsertsToSubscriptions("agg_items", filterer, [row], "id");
    expect(received).toEqual([row]);
  });

  it("forwards both new and previous rows on update", async () => {
    let received: Record<string, unknown>[] | undefined;
    registerAggregateWatcher("agg_items", (changed) => {
      received = changed;
    });
    const filterer = createResourceFilter(items, {});
    const next = { id: 3, name: "z", status: "active", amount: 9 };
    const prev = new Map([["3", { id: 3, name: "z", status: "done", amount: 9 }]]);
    await pushUpdatesToSubscriptions("agg_items", filterer, [next], "id", prev);
    expect(received).toContainEqual(next);
    expect(received).toContainEqual({ id: 3, name: "z", status: "done", amount: 9 });
  });

  it("forwards deleted rows so out-of-scope deletes can be skipped", async () => {
    let received: Record<string, unknown>[] | undefined;
    registerAggregateWatcher("agg_items", (changed) => {
      received = changed;
    });
    const row = { id: 9, name: "g", status: "done", amount: 2 };
    await pushDeletesToSubscriptions("agg_items", ["9"], [row]);
    expect(received).toEqual([row]);
  });
});

describe("canonicalizeAggregation", () => {
  it("is order-independent across group ordering", () => {
    const a = {
      groups: [
        { key: { status: "active" }, count: 2 },
        { key: { status: "done" }, count: 1 },
      ],
    };
    const b = {
      groups: [
        { key: { status: "done" }, count: 1 },
        { key: { status: "active" }, count: 2 },
      ],
    };
    expect(canonicalizeAggregation(a)).toBe(canonicalizeAggregation(b));
  });

  it("differs when a count actually changes", () => {
    const a = { groups: [{ key: { status: "active" }, count: 2 }] };
    const b = { groups: [{ key: { status: "active" }, count: 3 }] };
    expect(canonicalizeAggregation(a)).not.toBe(canonicalizeAggregation(b));
  });

  it("differs when a group is added or removed", () => {
    const a = { groups: [{ key: { status: "active" }, count: 2 }] };
    const b = {
      groups: [
        { key: { status: "active" }, count: 2 },
        { key: { status: "done" }, count: 1 },
      ],
    };
    expect(canonicalizeAggregation(a)).not.toBe(canonicalizeAggregation(b));
  });
});

describe("GET /aggregate/subscribe", () => {
  let app: ReturnType<typeof createTestApp>;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    await clearAllSubscriptions();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE agg_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        amount INTEGER NOT NULL
      )
    `);
    await libsqlClient.execute(
      `INSERT INTO agg_items (name, status, amount) VALUES ('a','active',10),('b','active',20),('c','done',5)`
    );

    app = createTestApp({ user: {} });
    app.route(
      "/items",
      useResource(items, {
        id: items.id,
        db,
        sse: { aggregateDebounceMs: 10 },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
  });

  it("sends an initial aggregate snapshot on connect", async () => {
    const { collector } = await SSECollector.connect(
      app,
      "/items/aggregate/subscribe?groupBy=status&count=true"
    );
    const event = await collector.waitFor((e) => e.event === "aggregate");
    expect(event).not.toBeNull();
    const groups = event!.data.data.groups as { key: any; count: number }[];
    const byStatus = Object.fromEntries(
      groups.map((g) => [g.key.status, g.count])
    );
    expect(byStatus.active).toBe(2);
    expect(byStatus.done).toBe(1);
    collector.close();
  });

  it("re-emits the aggregate after a mutation", async () => {
    const { collector } = await SSECollector.connect(
      app,
      "/items/aggregate/subscribe?groupBy=status&count=true"
    );
    const first = await collector.waitFor((e) => e.event === "aggregate");
    expect(first).not.toBeNull();

    // Insert another "active" row through the resource API.
    await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "d", status: "active", amount: 1 }),
    });

    const next = await collector.waitFor((e) => e.event === "aggregate", 3000);
    expect(next).not.toBeNull();
    const groups = next!.data.data.groups as { key: any; count: number }[];
    const active = groups.find((g) => g.key.status === "active");
    expect(active?.count).toBe(3);
    collector.close();
  });

  it("does not re-emit when a mutation leaves the aggregate unchanged", async () => {
    const { collector } = await SSECollector.connect(
      app,
      "/items/aggregate/subscribe?groupBy=status&count=true"
    );
    const first = await collector.waitFor((e) => e.event === "aggregate");
    expect(first).not.toBeNull();

    // Rename a row — does not touch the grouped field (status) or the count.
    await app.request("/items/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });

    // No second aggregate event should arrive (result is identical).
    const next = await collector.waitFor((e) => e.event === "aggregate", 500);
    expect(next).toBeNull();
    collector.close();
  });

  it("does not re-emit for a mutation outside the aggregate's filter scope", async () => {
    const { collector } = await SSECollector.connect(
      app,
      '/items/aggregate/subscribe?filter=status=="active"&count=true'
    );
    const first = await collector.waitFor((e) => e.event === "aggregate");
    expect(first).not.toBeNull();
    expect(first!.data.data.groups[0].count).toBe(2);

    // Insert a row that does NOT match the subscription filter (status=done).
    await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e", status: "done", amount: 1 }),
    });
    const skipped = await collector.waitFor((e) => e.event === "aggregate", 400);
    expect(skipped).toBeNull();

    // Insert a matching row — now it re-emits with the new count.
    await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "f", status: "active", amount: 1 }),
    });
    const next = await collector.waitFor((e) => e.event === "aggregate", 3000);
    expect(next).not.toBeNull();
    expect(next!.data.data.groups[0].count).toBe(3);
    collector.close();
  });

  it("skips out-of-scope deletes but re-emits for in-scope deletes", async () => {
    const { collector } = await SSECollector.connect(
      app,
      '/items/aggregate/subscribe?filter=status=="active"&count=true'
    );
    const first = await collector.waitFor((e) => e.event === "aggregate");
    expect(first!.data.data.groups[0].count).toBe(2);

    // Delete the "done" row (id 3) — outside the active filter, must not re-emit.
    await app.request("/items/3", { method: "DELETE" });
    const skipped = await collector.waitFor((e) => e.event === "aggregate", 400);
    expect(skipped).toBeNull();

    // Delete an "active" row (id 1) — in scope, must re-emit with count 1.
    await app.request("/items/1", { method: "DELETE" });
    const next = await collector.waitFor((e) => e.event === "aggregate", 3000);
    expect(next).not.toBeNull();
    expect(next!.data.data.groups[0].count).toBe(1);
    collector.close();
  });

  it("applies a filter to the aggregate scope", async () => {
    const { collector } = await SSECollector.connect(
      app,
      '/items/aggregate/subscribe?filter=status=="active"&sum=amount&count=true'
    );
    const event = await collector.waitFor((e) => e.event === "aggregate");
    expect(event).not.toBeNull();
    const group = event!.data.data.groups[0];
    expect(group.count).toBe(2);
    expect(group.sum.amount).toBe(30);
    collector.close();
  });
});
