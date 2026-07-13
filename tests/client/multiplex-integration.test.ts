import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { createMultiplexRouter } from "@/server/multiplex";
import { setResourceMountPath, clearSchemaRegistry } from "@/ui/schema-registry";
import { clearSubscribeDispatchers } from "@/resource/mux-registry";
import { SharedSSEConnection } from "@/client/shared-sse";
import { createTestApp, post, flushAsync } from "../helpers/hono";

// End-to-end: the real client SharedSSEConnection talks to the real server
// multiplex endpoint over app.request, proving the wire protocol matches on both
// sides (framing, subscribe/unsubscribe, demux).
const items = sqliteTable("mxi_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category").notNull(),
});

describe("multiplex client <-> server integration", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;
  let conn: SharedSSEConnection;

  beforeEach(async () => {
    clearSchemaRegistry();
    clearSubscribeDispatchers();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE mxi_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL)`
    );
    db = drizzle(libsqlClient);
    app = createTestApp({ user: { id: "u1" } });
    app.route("/__covara/stream", createMultiplexRouter());
    app.route("/api/mxi_items", useResource(items, { id: items.id, db }));
    setResourceMountPath("mxi_items", "/api/mxi_items");

    conn = new SharedSSEConnection({
      buildUrl: (p) => p,
      getHeaders: () => ({}),
      // Route the client's stream + control requests into the Hono app.
      fetchImpl: ((url: string, init?: RequestInit) =>
        app.request(url, init as never)) as unknown as typeof fetch,
      createNativeEventSource: () => {
        throw new Error("native EventSource should not be used in this test");
      },
    });
  });

  afterEach(async () => {
    await flushAsync();
    libsqlClient.close();
  });

  it("delivers live events to a multiplexed channel end to end", async () => {
    const channel = conn.openChannel("/api/mxi_items/subscribe", { filter: 'category=="x"' });
    const added: any[] = [];
    let connected = false;
    channel.addEventListener("connected", () => (connected = true));
    channel.addEventListener("message", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "added") added.push(ev.object);
    });

    // Let the stream open, ready arrive, and the subscribe POST complete.
    await flushAsync(50);
    expect(connected).toBe(true);

    // Matching mutation is delivered; non-matching is filtered out.
    await post(app, "/api/mxi_items", { name: "keep", category: "x" });
    await post(app, "/api/mxi_items", { name: "drop", category: "y" });
    await flushAsync(50);

    expect(added.map((a) => a.name)).toEqual(["keep"]);

    channel.close();
    await flushAsync();
  });

  it("multiplexes two channels over a single shared stream", async () => {
    let streamOpens = 0;
    const counting = new SharedSSEConnection({
      buildUrl: (p) => p,
      getHeaders: () => ({}),
      fetchImpl: ((url: string, init?: RequestInit) => {
        if (url.endsWith("/__covara/stream")) streamOpens++;
        return app.request(url, init as never);
      }) as unknown as typeof fetch,
      createNativeEventSource: () => {
        throw new Error("should not fall back");
      },
    });

    const a = counting.openChannel("/api/mxi_items/subscribe", { filter: 'category=="x"' });
    const b = counting.openChannel("/api/mxi_items/subscribe", { filter: 'category=="y"' });
    const aNames: string[] = [];
    const bNames: string[] = [];
    a.addEventListener("message", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "added") aNames.push(ev.object.name);
    });
    b.addEventListener("message", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "added") bNames.push(ev.object.name);
    });

    await flushAsync(50);

    await post(app, "/api/mxi_items", { name: "ax", category: "x" });
    await post(app, "/api/mxi_items", { name: "by", category: "y" });
    await flushAsync(50);

    expect(streamOpens).toBe(1);
    expect(aNames).toEqual(["ax"]);
    expect(bNames).toEqual(["by"]);

    a.close();
    b.close();
    await flushAsync();
  });
});
