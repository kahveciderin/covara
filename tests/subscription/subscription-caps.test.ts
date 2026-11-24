import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { createCovara } from "@/server/app";
import { configureClientIp } from "@/server/request";
import { clearAllSubscriptions } from "@/resource/subscription";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { clearSubscribeDispatchers } from "@/resource/mux-registry";
import type { SSEConfig } from "@/resource/types";

const capItems = sqliteTable("cap_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

describe("live subscription caps", () => {
  const open: AbortController[] = [];

  beforeEach(async () => {
    await clearAllSubscriptions();
    clearSchemaRegistry();
    clearSubscribeDispatchers();
    configureClientIp({ clientIp: () => "10.20.30.40" });
  });

  afterEach(async () => {
    for (const controller of open.splice(0)) controller.abort();
    configureClientIp({});
    await clearAllSubscriptions();
  });

  const build = async (appSse?: { maxSubscriptionsPerIP?: number; maxSubscriptionsPerUser?: number }, resourceSse?: SSEConfig) => {
    const client = createLibsqlClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE cap_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const app = createCovara({ sse: appSse, securityHeaders: false, multiplex: false });
    app.use("*", async (c, next) => {
      const id = c.req.header("x-user");
      if (id) c.set("user", { id });
      await next();
    });
    app.resource("/items", capItems, { id: capItems.id, db: drizzle(client), sse: resourceSse, auth: { public: true } });
    return app;
  };

  const subscribe = async (app: Awaited<ReturnType<typeof build>>, user?: string) => {
    const controller = new AbortController();
    open.push(controller);
    const res = await app.request("/api/items/subscribe", {
      headers: user ? { "x-user": user } : {},
      signal: controller.signal,
    });
    return res.status;
  };

  it("signed-in users behind one address are not limited by the per-IP cap", async () => {
    const app = await build();
    const statuses = [];
    for (let i = 0; i < 55; i++) statuses.push(await subscribe(app, `user-${i}`));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("signed-in users still hit the per-user cap", async () => {
    const app = await build();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push(await subscribe(app, "same-user"));
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("anonymous clients are still capped per IP", async () => {
    const app = await build(undefined, { maxSubscriptionsPerUser: 1000 });
    const statuses = [];
    for (let i = 0; i < 51; i++) statuses.push(await subscribe(app));
    expect(statuses.slice(0, 50).filter((s) => s !== 200)).toEqual([]);
    expect(statuses[50]).toBe(429);
  });

  it("signed-in subscriptions don't use up the anonymous per-IP allowance", async () => {
    const app = await build({ maxSubscriptionsPerIP: 2, maxSubscriptionsPerUser: 1000 });
    for (let i = 0; i < 5; i++) expect(await subscribe(app, `u${i}`)).toBe(200);
    expect(await subscribe(app)).toBe(200);
    expect(await subscribe(app)).toBe(200);
    expect(await subscribe(app)).toBe(429);
  });

  it("createCovara({ sse }) sets the caps for every resource", async () => {
    const app = await build({ maxSubscriptionsPerIP: 3, maxSubscriptionsPerUser: 2 });
    expect([await subscribe(app), await subscribe(app), await subscribe(app), await subscribe(app)]).toEqual([200, 200, 200, 429]);
    expect([await subscribe(app, "u"), await subscribe(app, "u"), await subscribe(app, "u")]).toEqual([200, 200, 429]);
  });

  it("a resource's own sse setting wins over the app-wide one", async () => {
    const app = await build({ maxSubscriptionsPerIP: 1 }, { maxSubscriptionsPerIP: 2 });
    expect([await subscribe(app), await subscribe(app), await subscribe(app)]).toEqual([200, 200, 429]);
  });

  it("a slot is given back when the stream closes", async () => {
    const app = await build({ maxSubscriptionsPerIP: 1 });
    expect(await subscribe(app)).toBe(200);
    open.pop()!.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(await subscribe(app)).toBe(200);
  });

  it("rejects a cap that isn't a positive integer", () => {
    expect(() => createCovara({ sse: { maxSubscriptionsPerIP: 0 } })).toThrow(/maxSubscriptionsPerIP/);
    expect(() => createCovara({ sse: { maxSubscriptionsPerUser: 1.5 } })).toThrow(/maxSubscriptionsPerUser/);
  });
});
