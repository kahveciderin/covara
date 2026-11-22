import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { useFileResource } from "@/storage/resource";
import { MemoryStorageAdapter } from "@/storage/memory";
import { createMultiplexRouter } from "@/server/multiplex";
import { setResourceMountPath, getResourceSchema } from "@/ui/schema-registry";
import type { ResourceCapabilities } from "@/resource/types";
import { createTestApp, request, SSECollector } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const items = sqliteTable("cap_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const files = sqliteTable("cap_files", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

describe("capabilities are enforced", () => {
  let t: TempDb;

  beforeEach(async () => {
    t = await openTempDb(`
      CREATE TABLE cap_items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE cap_files (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mimeType TEXT NOT NULL, size INTEGER NOT NULL, storagePath TEXT NOT NULL, url TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO cap_items VALUES ('a', 'original');
    `);
  });
  afterEach(() => t.close());

  const build = (capabilities?: ResourceCapabilities) => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/items", useResource(items, { id: items.id, db: t.db, capabilities }));
    return app;
  };
  const snapshot = async () => (await t.client.execute("SELECT * FROM cap_items")).rows.map((r) => [r.id, r.name]);

  const cases: [keyof ResourceCapabilities, string, string, unknown?][] = [
    ["enableCreate", "POST", "/items", { id: "b", name: "x" }],
    ["enableCreate", "POST", "/items/batch", { items: [{ id: "b", name: "x" }] }],
    ["enableCreate", "POST", "/items/batch/upsert", { items: [{ id: "b", name: "x" }] }],
    ["enableUpdate", "PATCH", "/items/a", { name: "x" }],
    ["enableUpdate", "PUT", "/items/a", { id: "a", name: "x" }],
    ["enableUpdate", "PATCH", "/items/batch", { name: "x" }],
    ["enableUpdate", "POST", "/items/batch/upsert", { items: [{ id: "a", name: "x" }] }],
    ["enableDelete", "DELETE", "/items/a"],
    ["enableDelete", "DELETE", "/items/batch"],
    ["enableBatch", "POST", "/items/batch", { items: [{ id: "b", name: "x" }] }],
    ["enableBatch", "POST", "/items/batch/upsert", { items: [{ id: "b", name: "x" }] }],
    ["enableBatch", "PATCH", "/items/batch", { name: "x" }],
    ["enableBatch", "DELETE", "/items/batch"],
    ["enableAggregations", "GET", "/items/aggregate?count=true"],
    ["enableAggregations", "GET", "/items/aggregate/subscribe?count=true"],
    ["enableSubscribe", "GET", "/items/subscribe"],
    ["enableSubscribe", "GET", "/items/aggregate/subscribe?count=true"],
  ];

  it.each(cases)("%s:false refuses %s %s", async (capability, method, path, body) => {
    const app = build({ [capability]: false });
    const before = await snapshot();
    const init: RequestInit = { method };
    if (body) Object.assign(init, { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const res = await app.request(path, init);
    expect(res.status).toBe(405);
    expect((await res.json()).code).toBe("OPERATION_DISABLED");
    expect(await snapshot()).toEqual(before);
  });

  it("refuses before parsing the body", async () => {
    const res = await request(build({ enableCreate: false }), "POST", "/items", { nonsense: true });
    expect(res.status).toBe(405);
  });

  it("leaves the other operations working", async () => {
    const app = build({ enableDelete: false });
    expect((await request(app, "POST", "/items", { id: "b", name: "x" })).status).toBe(201);
    expect((await request(app, "PATCH", "/items/b", { name: "y" })).status).toBe(200);
    expect((await request(app, "GET", "/items/b")).status).toBe(200);
    expect((await request(app, "GET", "/items/count")).status).toBe(200);
  });

  it.each([undefined, {}])("keeps batch routes on when capabilities are %j and batch is not configured", async (caps) => {
    const app = build(caps);
    expect((await request(app, "POST", "/items/batch", { items: [{ id: "b", name: "x" }] })).status).toBe(200);
    expect(getResourceSchema("cap_items")?.config.capabilities?.enableBatch).toBe(true);
  });

  it.each([
    ["enableSubscribe", "resource"],
    ["enableSubscribe", "aggregate"],
    ["enableAggregations", "aggregate"],
  ])("%s:false refuses a multiplexed %s channel", async (capability, kind) => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/__covara/stream", createMultiplexRouter());
    app.route("/api/cap_items", useResource(items, { id: items.id, db: t.db, capabilities: { [capability]: false } }));
    setResourceMountPath("cap_items", "/api/cap_items");
    const { collector } = await SSECollector.connect(app, "/__covara/stream");
    try {
      const ready = await collector.next();
      const res = await request(app, "POST", `/__covara/stream/${ready!.data.cid}/subscribe`, {
        channelId: "c1",
        resource: "/api/cap_items",
        kind,
        aggregateQuery: { count: "true" },
      });
      expect(res.status).toBe(405);
    } finally {
      collector.close();
    }
  });

  describe("file resource routes", () => {
    const fileApp = (capabilities: ResourceCapabilities) => {
      const app = createTestApp({ user: { id: "u1" } });
      app.route(
        "/files",
        useFileResource(files as any, { db: t.db, id: files.id, storage: new MemoryStorageAdapter(), capabilities } as any)
      );
      return app;
    };

    it.each([
      ["POST", "/files"],
      ["GET", "/files/upload-url?filename=a.txt"],
      ["POST", "/files/uploads"],
      ["POST", "/files/f1/confirm"],
    ])("enableCreate:false refuses %s %s", async (method, path) => {
      expect((await request(fileApp({ enableCreate: false }), method, path)).status).toBe(405);
    });

    it.each(["enableDelete", "enableBatch"])("%s:false refuses DELETE /files/batch", async (capability) => {
      const res = await request(fileApp({ [capability]: false }), "DELETE", "/files/batch", { ids: ["f1"] });
      expect(res.status).toBe(405);
    });
  });
});
