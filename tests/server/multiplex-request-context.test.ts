import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { createMultiplexRouter } from "@/server/multiplex";
import { setResourceMountPath, clearSchemaRegistry } from "@/ui/schema-registry";
import { clearSubscribeDispatchers } from "@/resource/mux-registry";
import { clearAllSubscriptions } from "@/resource/subscription";
import { setGlobalKV, clearGlobalKV } from "@/kv";
import { createMemoryKV } from "@/kv/memory";
import { createTestApp, post, SSECollector } from "../helpers/hono";
import {
  bindScopedSocketsToRequests,
  inRequest,
  inStreamingRequest,
  ioViolations,
  type RequestCtx,
  type ScopedSocketRecord,
} from "../helpers/request-context";

// Workers model: an SSE stream may only be written from the request context that
// opened it. A write from any other request fails, as it does on Workers.
vi.mock("@/server/sse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sse")>();
  const { currentCtx, ioViolations: violations } = await import("../helpers/request-context");
  return {
    ...actual,
    createSSEStream: (options: Parameters<typeof actual.createSSEStream>[0]) => {
      const owner = currentCtx();
      const { writer, response } = actual.createSSEStream(options);
      const guarded = Object.create(writer) as typeof writer;
      guarded.write = (chunk: string) => {
        const from = currentCtx();
        if (owner && from !== owner) {
          violations.push({ kind: "write", owner: owner.name, from: from?.name ?? "<none>" });
          return false;
        }
        return writer.write(chunk);
      };
      return { writer: guarded, response };
    },
  };
});

const ctxItems = sqliteTable("ctx_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const muxFrames = (collector: SSECollector, channelId: string, name: string) =>
  collector.events
    .filter((e) => e.event === "mux")
    .map((e) => e.data)
    .filter((f) => f.c === channelId && f.n === name);

describe("multiplex stream on a Workers-style per-request I/O runtime", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let app: ReturnType<typeof createTestApp>;
  let sockets: ScopedSocketRecord[];
  const streams: { collector: SSECollector; ctx: RequestCtx }[] = [];

  beforeEach(async () => {
    await clearAllSubscriptions();
    clearSchemaRegistry();
    clearSubscribeDispatchers();
    ioViolations.length = 0;

    const kv = createMemoryKV();
    await kv.connect();
    sockets = bindScopedSocketsToRequests(kv);
    setGlobalKV(kv);

    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE ctx_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner TEXT NOT NULL)`
    );
    const db = drizzle(libsqlClient);

    app = createTestApp({ user: { id: "u1" } });
    app.route("/__covara/stream", createMultiplexRouter());
    app.route(
      "/api/ctx_items",
      useResource(ctxItems, {
        id: ctxItems.id,
        db,
        sse: { maxSubscriptionsPerUser: 2, aggregateDebounceMs: 10 },
      })
    );
    setResourceMountPath("ctx_items", "/api/ctx_items");
  });

  afterEach(async () => {
    for (const { collector, ctx } of streams.splice(0)) {
      collector?.close();
      ctx.alive = false;
    }
    await new Promise((r) => setTimeout(r, 20));
    await clearAllSubscriptions();
    clearGlobalKV();
    libsqlClient.close();
  });

  const openStream = async () => {
    const { result, ctx } = await inStreamingRequest("GET stream", () =>
      SSECollector.connect(app, "/__covara/stream")
    );
    const { collector } = result;
    streams.push({ collector, ctx });
    const ready = await collector.next();
    expect(ready?.event).toBe("ready");
    return { collector, cid: ready!.data.cid as string, ctx };
  };

  const openLegacy = async (path: string) => {
    const { result, ctx } = await inStreamingRequest("GET legacy", () =>
      SSECollector.connect(app, path)
    );
    streams.push({ collector: result.collector, ctx });
    return { collector: result.collector, ctx };
  };

  const control = (cid: string, action: "subscribe" | "unsubscribe", body: Record<string, unknown>) =>
    inRequest(`POST ${action}`, () => post(app, `/__covara/stream/${cid}/${action}`, body));

  const insert = (name: string, owner = "u1") =>
    inRequest("POST insert", () => post(app, "/api/ctx_items", { name, owner }));

  it("delivers mutations to a channel subscribed by a separate control request", async () => {
    const { collector, cid } = await openStream();

    const res = await control(cid, "subscribe", { channelId: "ch1", resource: "/api/ctx_items" });
    expect(res.status).toBe(200);
    await waitFor(() => muxFrames(collector, "ch1", "connected").length > 0);

    await insert("A");
    await waitFor(() =>
      muxFrames(collector, "ch1", "message").some(
        (f) => f.d.type === "added" && f.d.object?.name === "A"
      )
    );
    expect(ioViolations).toEqual([]);
  });

  it("binds every channel's fan-out socket to the stream's request, not the control request", async () => {
    const { collector, cid, ctx } = await openStream();
    await control(cid, "subscribe", { channelId: "ch1", resource: "/api/ctx_items" });
    await waitFor(() => muxFrames(collector, "ch1", "connected").length > 0);

    const fanout = sockets.filter((s) => s.channels.includes("covara:events"));
    expect(fanout.length).toBeGreaterThan(0);
    for (const socket of fanout) expect(socket.openedIn).toBe(ctx.name);
  });

  it("keeps delivering to every channel across many mutations", async () => {
    const { collector, cid } = await openStream();
    await control(cid, "subscribe", { channelId: "a", resource: "/api/ctx_items", filter: 'name=="x"' });
    await control(cid, "subscribe", { channelId: "b", resource: "/api/ctx_items", filter: 'name=="y"' });
    await waitFor(
      () =>
        muxFrames(collector, "a", "connected").length > 0 &&
        muxFrames(collector, "b", "connected").length > 0
    );

    await insert("x");
    await insert("y");
    await insert("x");
    await waitFor(
      () =>
        muxFrames(collector, "a", "message").filter((f) => f.d.type === "added").length === 2 &&
        muxFrames(collector, "b", "message").filter((f) => f.d.type === "added").length === 1
    );
    expect(ioViolations).toEqual([]);
  });

  it("recomputes aggregate channels inside the stream's request", async () => {
    await insert("seed");
    const { collector, cid } = await openStream();
    await control(cid, "subscribe", {
      channelId: "agg",
      resource: "/api/ctx_items",
      kind: "aggregate",
      aggregate: { count: "true" },
    });
    await waitFor(() => muxFrames(collector, "agg", "aggregate").length > 0);

    await insert("more");
    await waitFor(() => muxFrames(collector, "agg", "aggregate").length > 1);
    expect(ioViolations).toEqual([]);
  });

  it("closes a channel's socket from the stream's request on unsubscribe and stops delivery", async () => {
    const { collector, cid, ctx } = await openStream();
    await control(cid, "subscribe", { channelId: "ch1", resource: "/api/ctx_items" });
    await waitFor(() => muxFrames(collector, "ch1", "connected").length > 0);

    const un = await control(cid, "unsubscribe", { channelId: "ch1" });
    expect(un.status).toBe(200);
    await waitFor(() =>
      sockets.some((s) => s.channels.includes("covara:events") && s.closedFrom !== undefined)
    );
    const closed = sockets.find((s) => s.channels.includes("covara:events") && s.closedFrom);
    expect(closed!.closedFrom).toBe(ctx.name);

    await insert("after");
    await new Promise((r) => setTimeout(r, 50));
    expect(muxFrames(collector, "ch1", "message")).toEqual([]);
    expect(ioViolations).toEqual([]);
  });

  it("rejects an invalid subscription synchronously from the control request", async () => {
    const { cid } = await openStream();
    const res = await control(cid, "subscribe", {
      channelId: "bad",
      resource: "/api/ctx_items",
      filter: "name===",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate channel id even while its start is still pending", async () => {
    const { cid } = await openStream();
    const [first, second] = await Promise.all([
      control(cid, "subscribe", { channelId: "dup", resource: "/api/ctx_items" }),
      control(cid, "subscribe", { channelId: "dup", resource: "/api/ctx_items" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it("releases reserved subscription slots when the stream closes before a channel starts", async () => {
    const first = await openStream();
    await control(first.cid, "subscribe", { channelId: "a", resource: "/api/ctx_items" });
    await control(first.cid, "subscribe", { channelId: "b", resource: "/api/ctx_items" });
    first.collector.close();
    first.ctx.alive = false;
    await new Promise((r) => setTimeout(r, 30));

    const second = await openStream();
    const res = await control(second.cid, "subscribe", { channelId: "c", resource: "/api/ctx_items" });
    expect(res.status).toBe(200);
    await waitFor(() => muxFrames(second.collector, "c", "connected").length > 0);
  });

  it("legacy /subscribe streams are only written from their own request", async () => {
    const { collector } = await openLegacy("/api/ctx_items/subscribe");
    await waitFor(() => collector.events.some((e) => e.event === "connected"));

    await insert("L");
    await waitFor(() =>
      collector.events.some((e) => e.data?.type === "added" && e.data?.object?.name === "L")
    );
    expect(ioViolations).toEqual([]);
  });

  it("legacy aggregate streams recompute only inside their own request", async () => {
    const { collector } = await openLegacy("/api/ctx_items/aggregate/subscribe?count=true");
    await waitFor(() => collector.events.some((e) => e.event === "aggregate"));

    await insert("agg");
    await waitFor(() => collector.events.filter((e) => e.event === "aggregate").length > 1);
    expect(ioViolations).toEqual([]);
  });
});
