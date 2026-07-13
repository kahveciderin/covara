import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { createMultiplexRouter } from "@/server/multiplex";
import { setResourceMountPath, clearSchemaRegistry } from "@/ui/schema-registry";
import { clearSubscribeDispatchers } from "@/resource/mux-registry";
import { setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";
import { createTestApp, post, SSECollector, flushAsync } from "../helpers/hono";

const muxItems = sqliteTable("mux_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category").notNull(),
});

describe("SSE multiplex endpoint", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;
  const collectors: SSECollector[] = [];

  beforeEach(async () => {
    clearSchemaRegistry();
    clearSubscribeDispatchers();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE mux_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL)`
    );
    db = drizzle(libsqlClient);

    app = createTestApp({ user: { id: "u1" } });
    app.route("/__covara/stream", createMultiplexRouter());
    app.route("/api/mux_items", useResource(muxItems, { id: muxItems.id, db }));
    setResourceMountPath("mux_items", "/api/mux_items");
  });

  afterEach(async () => {
    for (const collector of collectors.splice(0)) collector.close();
    await flushAsync();
    libsqlClient.close();
  });

  const openStream = async () => {
    const { collector } = await SSECollector.connect(app, "/__covara/stream");
    collectors.push(collector);
    const ready = await collector.next();
    expect(ready?.event).toBe("ready");
    const cid = ready!.data.cid as string;
    return { collector, cid };
  };

  const subscribe = (cid: string, channelId: string, resource: string, extra: Record<string, unknown> = {}) =>
    post(app, `/__covara/stream/${cid}/subscribe`, { channelId, resource, ...extra });

  it("opens a shared stream and returns a ready event with a cid", async () => {
    const { cid } = await openStream();
    expect(typeof cid).toBe("string");
    expect(cid.length).toBeGreaterThan(0);
  });

  it("flushes ready immediately even when the changelog KV read hangs", async () => {
    // Regression: the handler used to `await changelog.getCurrentSequence()`
    // (a KV/DO read) before writing the first byte. On Workers a slow store read
    // there left the stream stuck at 0 bytes — no channel ever subscribed and
    // nothing updated. `ready` must flush without depending on the store.
    const hangingKV = {
      get: () => new Promise<string | null>(() => {}), // never resolves
    } as unknown as KVAdapter;
    setGlobalKV(hangingKV);
    try {
      const { collector } = await SSECollector.connect(app, "/__covara/stream");
      collectors.push(collector);
      const ready = await collector.next();
      expect(ready?.event).toBe("ready");
      expect(ready!.data.cid).toBeTruthy();
    } finally {
      clearGlobalKV();
    }
  });

  it("delivers framed events for a subscribed channel", async () => {
    const { collector, cid } = await openStream();

    const res = await subscribe(cid, "ch1", "/api/mux_items");
    expect(res.status).toBe(200);

    // The channel's initial "connected" frame arrives on the shared stream.
    const connected = await collector.next();
    expect(connected?.event).toBe("mux");
    const framed = connected!.data;
    expect(framed.c).toBe("ch1");
    expect(framed.n).toBe("connected");

    // A mutation produces a framed "added" event tagged with the channel id.
    await post(app, "/api/mux_items", { name: "A", category: "x" });
    await flushAsync();

    const muxEvents = collector.events
      .filter((e) => e.event === "mux")
      .map((e) => e.data)
      .filter((f) => f.c === "ch1" && f.n === "message");
    expect(muxEvents.length).toBeGreaterThan(0);
    expect(muxEvents.some((f) => f.d.type === "added" && f.d.object?.name === "A")).toBe(true);
  });

  it("multiplexes independent channels over one stream, isolated by filter", async () => {
    const { collector, cid } = await openStream();
    await subscribe(cid, "chX", "/api/mux_items", { filter: 'category=="x"' });
    await subscribe(cid, "chY", "/api/mux_items", { filter: 'category=="y"' });
    await flushAsync();

    await post(app, "/api/mux_items", { name: "onlyX", category: "x" });
    await flushAsync();

    const framed = collector.events
      .filter((e) => e.event === "mux")
      .map((e) => e.data)
      .filter((f) => f.n === "message" && f.d.type === "added");

    expect(framed.some((f) => f.c === "chX" && f.d.object?.name === "onlyX")).toBe(true);
    expect(framed.some((f) => f.c === "chY")).toBe(false);
  });

  it("stops delivering after unsubscribe", async () => {
    const { collector, cid } = await openStream();
    await subscribe(cid, "ch1", "/api/mux_items");
    await flushAsync();

    const un = await post(app, `/__covara/stream/${cid}/unsubscribe`, { channelId: "ch1" });
    expect(un.status).toBe(200);
    await flushAsync();

    const before = collector.events.filter((e) => e.event === "mux").length;
    await post(app, "/api/mux_items", { name: "B", category: "x" });
    await flushAsync();
    const after = collector.events.filter((e) => e.event === "mux").length;
    expect(after).toBe(before);
  });

  it("returns 409 stream_not_found for an unknown connection id", async () => {
    const res = await subscribe("does-not-exist", "ch1", "/api/mux_items");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stream_not_found");
  });

  it("returns 404 for an unknown resource path", async () => {
    const { cid } = await openStream();
    const res = await subscribe(cid, "ch1", "/api/nope");
    expect(res.status).toBe(404);
  });

  it("supports aggregate channels", async () => {
    await post(app, "/api/mux_items", { name: "A", category: "x" });
    const { collector, cid } = await openStream();
    const res = await subscribe(cid, "agg1", "/api/mux_items", {
      kind: "aggregate",
      aggregate: { count: "true" },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    const agg = collector.events
      .filter((e) => e.event === "mux")
      .map((e) => e.data)
      .filter((f) => f.c === "agg1" && f.n === "aggregate");
    expect(agg.length).toBeGreaterThan(0);
  });
});
