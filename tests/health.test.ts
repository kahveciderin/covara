import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createHealthEndpoints,
  runLivenessChecks,
  runReadinessChecks,
  checkEventLoop,
  checkMemory,
  checkKV,
} from "../src/health";
import { createMemoryKV } from "../src/kv";
import { createTestApp, get, request } from "./helpers/hono";

describe("Health Endpoints", () => {
  let app: Hono;
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    app = createTestApp();
    process.memoryUsage = vi.fn().mockReturnValue({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
      rss: 100 * 1024 * 1024,
    }) as unknown as typeof process.memoryUsage;
  });

  afterEach(() => {
    process.memoryUsage = originalMemoryUsage;
  });

  describe("createHealthEndpoints", () => {
    it("creates router with healthz and readyz endpoints", async () => {
      const router = createHealthEndpoints();
      app.route("/", router);

      const healthzRes = await get(app, "/healthz");
      expect(healthzRes.status).toBe(200);
      expect(healthzRes.body.status).toBe("healthy");
      expect(healthzRes.body.timestamp).toBeDefined();
      expect(healthzRes.body.uptime).toBeGreaterThanOrEqual(0);

      const readyzRes = await get(app, "/readyz");
      expect(readyzRes.status).toBe(200);
      expect(readyzRes.body.status).toBe("healthy");
    });

    it("supports custom base path", async () => {
      const router = createHealthEndpoints({ basePath: "/health" });
      app.route("/", router);

      const res = await get(app, "/health/healthz");
      expect(res.status).toBe(200);
    });

    it("returns disabled when enabled is false", async () => {
      const router = createHealthEndpoints({ enabled: false });
      app.route("/", router);

      const res = await get(app, "/healthz");
      expect(res.status).toBe(404);
    });

    it("includes version in response", async () => {
      const router = createHealthEndpoints({ version: "1.0.0" });
      app.route("/", router);

      const res = await get(app, "/healthz");
      expect(res.body.version).toBe("1.0.0");
    });

    it("supports HEAD requests", async () => {
      const router = createHealthEndpoints();
      app.route("/", router);

      const healthzHead = await request(app, "HEAD", "/healthz");
      expect(healthzHead.status).toBe(200);

      const readyzHead = await request(app, "HEAD", "/readyz");
      expect(readyzHead.status).toBe(200);
    });
  });

  describe("Liveness Checks", () => {
    it("checks event loop lag", async () => {
      const result = await checkEventLoop(100);
      expect(result.name).toBe("event_loop");
      expect(result.healthy).toBe(true);
      expect(result.latencyMs).toBeDefined();
    });

    it("checks memory usage - healthy", async () => {
      // Mock process.memoryUsage to ensure deterministic test results
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = vi.fn().mockReturnValue({
        heapUsed: 50 * 1024 * 1024, // 50MB
        heapTotal: 100 * 1024 * 1024, // 100MB - 50% usage
        external: 0,
        arrayBuffers: 0,
        rss: 100 * 1024 * 1024,
      }) as unknown as typeof process.memoryUsage;

      try {
        const result = await checkMemory(90);
        expect(result.name).toBe("memory");
        expect(result.healthy).toBe(true);
      } finally {
        process.memoryUsage = originalMemoryUsage;
      }
    });

    it("checks memory usage - unhealthy", async () => {
      // Mock high memory usage
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = vi.fn().mockReturnValue({
        heapUsed: 95 * 1024 * 1024, // 95MB
        heapTotal: 100 * 1024 * 1024, // 100MB - 95% usage
        external: 0,
        arrayBuffers: 0,
        rss: 100 * 1024 * 1024,
      }) as unknown as typeof process.memoryUsage;

      try {
        const result = await checkMemory(90);
        expect(result.name).toBe("memory");
        expect(result.healthy).toBe(false);
        expect(result.message).toMatch(/Memory usage/);
      } finally {
        process.memoryUsage = originalMemoryUsage;
      }
    });

    it("runs all liveness checks", async () => {
      const results = await runLivenessChecks();
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name)).toContain("event_loop");
      expect(results.map((r) => r.name)).toContain("memory");
    });
  });

  describe("Readiness Checks", () => {
    it("checks KV connection", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const result = await checkKV(kv);
      expect(result.name).toBe("kv");
      expect(result.healthy).toBe(true);
      await kv.disconnect();
    });

    it("runs readiness checks with KV", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const results = await runReadinessChecks({ kv });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("kv");
      expect(results[0].healthy).toBe(true);
      await kv.disconnect();
    });

    it("returns unhealthy for custom check failure", async () => {
      const results = await runReadinessChecks({
        custom: async () => ({
          healthy: false,
          name: "custom",
          message: "Custom check failed",
        }),
      });
      expect(results[0].healthy).toBe(false);
      expect(results[0].message).toBe("Custom check failed");
    });
  });

  describe("Integration", () => {
    it("returns 503 when check fails", async () => {
      const router = createHealthEndpoints({
        thresholds: { eventLoopLagMs: 0 },
      });
      app.route("/", router);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const res = await get(app, "/healthz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
    });

    it("includes KV check in readyz when configured", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const router = createHealthEndpoints({
        checks: { kv },
      });
      app.route("/", router);

      const res = await get(app, "/readyz");
      expect(res.status).toBe(200);
      expect(res.body.checks).toBeDefined();
      expect(res.body.checks.some((c: { name: string }) => c.name === "kv")).toBe(true);
      await kv.disconnect();
    });
  });
});
