import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { idempotencyMiddleware, validateIdempotencyKey } from "@/middleware/idempotency";
import { createMemoryKV } from "@/kv/memory";
import { createTestApp, get, post, patch } from "../helpers/hono";

const testOrdersTable = sqliteTable("test_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  product: text("product").notNull(),
  quantity: integer("quantity").notNull(),
  status: text("status").default("pending"),
});

describe("Idempotency Replay Tests", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let kvStore: ReturnType<typeof createMemoryKV>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-idempotency-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    kvStore = createMemoryKV("idempotency");
    await kvStore.connect();

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_orders`);
    await libsqlClient.execute(`
      CREATE TABLE test_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT DEFAULT 'pending'
      )
    `);
  });

  afterEach(async () => {
    await kvStore.disconnect();
    libsqlClient.close();
  });

  const setupAppWithIdempotency = (userId = "test-user"): Hono => {
    const testApp = createTestApp({
      user: { id: userId },
      middleware: [
        idempotencyMiddleware({
          storage: kvStore,
          ttlMs: 60000,
        }),
      ],
    });
    testApp.route(
      "/orders",
      useResource(testOrdersTable, {
        id: testOrdersTable.id,
        db,
      })
    );
    return testApp;
  };

  describe("validateIdempotencyKey", () => {
    it("should accept valid keys", () => {
      expect(validateIdempotencyKey("my-key-123")).toBe(true);
      expect(validateIdempotencyKey("abc_DEF_123")).toBe(true);
      expect(validateIdempotencyKey("a".repeat(256))).toBe(true);
    });

    it("should reject invalid keys", () => {
      expect(validateIdempotencyKey("")).toBe(false);
      expect(validateIdempotencyKey("short")).toBe(false);
      expect(validateIdempotencyKey("a".repeat(257))).toBe(false);
      expect(validateIdempotencyKey("key with space")).toBe(false);
      expect(validateIdempotencyKey("key@special")).toBe(false);
    });
  });

  it("should return same response for same idempotency key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "create-order-12345678";

    const res1 = await post(
      testApp,
      "/orders",
      { product: "Widget", quantity: 5 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res1.status).toBe(201);

    const res2 = await post(
      testApp,
      "/orders",
      { product: "Widget", quantity: 5 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res2.status).toBe(201);

    expect(res1.body.id).toBe(res2.body.id);
    expect(res1.body.product).toBe(res2.body.product);
    expect(res1.body.quantity).toBe(res2.body.quantity);

    const listRes = await get(testApp, "/orders");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.length).toBe(1);
  });

  it("should execute once for concurrent requests with same key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "concurrent-order-12345";

    // Concurrent load over real sockets to exercise the race between requests
    const { server, port } = await new Promise<{ server: ServerType; port: number }>(
      (resolve) => {
        const s = serve({ fetch: testApp.fetch, port: 0 }, (info) =>
          resolve({ server: s, port: info.port })
        );
      }
    );

    try {
      const requests = Array.from({ length: 10 }, () =>
        fetch(`http://localhost:${port}/orders`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ product: "Gadget", quantity: 1 }),
        }).then(async (r) => ({ status: r.status, body: await r.json() }))
      );

      const results = await Promise.all(requests);

      const successResponses = results.filter((r) => r.status === 201);
      expect(successResponses.length).toBeGreaterThan(0);

      const ids = successResponses.map((r) => r.body.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1);

      const listRes = await get(testApp, "/orders");
      expect(listRes.status).toBe(200);
      expect(listRes.body.items.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should reject different request body with same key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "mismatch-order-123456";

    const res1 = await post(
      testApp,
      "/orders",
      { product: "ItemA", quantity: 1 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res1.status).toBe(201);

    const res2 = await post(
      testApp,
      "/orders",
      { product: "ItemB", quantity: 2 },
      { "idempotency-key": idempotencyKey }
    );

    expect(res2.status).toBe(409);
    expect(res2.body.detail || res2.body.title || "").toMatch(/[Ii]dempotency/);
  });

  it("should allow same key for different users", async () => {
    const idempotencyKey = "shared-key-12345678";

    const app1 = setupAppWithIdempotency("user-1");
    const app2 = setupAppWithIdempotency("user-2");

    const res1 = await post(
      app1,
      "/orders",
      { product: "Product1", quantity: 1 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res1.status).toBe(201);

    const res2 = await post(
      app2,
      "/orders",
      { product: "Product2", quantity: 2 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res2.status).toBe(201);

    expect(res1.body.id).not.toBe(res2.body.id);
    expect(res1.body.product).toBe("Product1");
    expect(res2.body.product).toBe("Product2");
  });

  it("should not apply idempotency to GET requests", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "get-request-12345678";

    const createRes = await post(testApp, "/orders", { product: "TestProduct", quantity: 1 });
    expect(createRes.status).toBe(201);

    const res1 = await get(testApp, "/orders", { "idempotency-key": idempotencyKey });
    expect(res1.status).toBe(200);

    const createRes2 = await post(testApp, "/orders", { product: "AnotherProduct", quantity: 2 });
    expect(createRes2.status).toBe(201);

    const res2 = await get(testApp, "/orders", { "idempotency-key": idempotencyKey });
    expect(res2.status).toBe(200);

    expect(res2.body.items.length).toBe(2);
  });

  it("should work without idempotency key - creates multiple resources", async () => {
    const testApp = setupAppWithIdempotency();

    const requests = Array.from({ length: 5 }, () =>
      post(testApp, "/orders", { product: "NoKeyProduct", quantity: 1 })
    );

    const results = await Promise.all(requests);

    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(5);

    const listRes = await get(testApp, "/orders");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.length).toBe(5);
  });

  it("should apply idempotency to PATCH requests", async () => {
    const testApp = setupAppWithIdempotency();

    const createRes = await post(testApp, "/orders", { product: "Original", quantity: 1 });
    expect(createRes.status).toBe(201);

    const orderId = createRes.body.id;
    const idempotencyKey = "update-order-12345678";

    const res1 = await patch(
      testApp,
      `/orders/${orderId}`,
      { quantity: 10 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res1.status).toBe(200);

    const res2 = await patch(
      testApp,
      `/orders/${orderId}`,
      { quantity: 10 },
      { "idempotency-key": idempotencyKey }
    );
    expect(res2.status).toBe(200);

    expect(res1.body.quantity).toBe(res2.body.quantity);
    expect(res1.body.quantity).toBe(10);
  });

  it("should not cache server errors (5xx)", async () => {
    const testApp = createTestApp({
      user: { id: "test-user" },
      middleware: [
        idempotencyMiddleware({
          storage: kvStore,
          ttlMs: 60000,
        }),
      ],
    });

    let callCount = 0;
    testApp.post("/flaky", (c) => {
      callCount++;
      if (callCount === 1) {
        return c.json({ error: "Server error" }, 500);
      }
      return c.json({ success: true, attempt: callCount }, 201);
    });

    const idempotencyKey = "flaky-operation-1234";

    const res1 = await post(testApp, "/flaky", undefined, {
      "idempotency-key": idempotencyKey,
    });
    expect(res1.status).toBe(500);

    const res2 = await post(testApp, "/flaky", undefined, {
      "idempotency-key": idempotencyKey,
    });
    expect(res2.status).toBe(201);

    expect(res2.body.success).toBe(true);
    expect(res2.body.attempt).toBe(2);
  });
});
