import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  observabilityMiddleware,
  requestIdMiddleware,
  timingMiddleware,
  resourceContextMiddleware,
  getRequestId,
  getRequestDuration,
  createMetricsCollector,
  ObservabilityConfig,
  RequestMetrics,
} from "@/middleware/observability";
import {
  createLogger,
  getLogger,
  setLogger,
  type LogRecord,
} from "@/server/logger";

describe("Observability Middleware", () => {
  const buildApp = (
    middleware: MiddlewareHandler[],
    onRequest?: (c: Context) => void | Promise<void>
  ): Hono => {
    const app = new Hono();
    for (const mw of middleware) {
      app.use("*", mw);
    }
    app.get("/users", async (c) => {
      await onRequest?.(c);
      return c.json({ ok: true });
    });
    return app;
  };

  describe("requestIdMiddleware", () => {
    it("should generate request ID if not present", async () => {
      let captured: string | undefined;
      const app = buildApp([requestIdMiddleware()], (c) => {
        captured = c.get("requestId");
      });

      const res = await app.request("/users");

      expect(captured).toBeDefined();
      expect(res.headers.get("X-Request-Id")).toBe(captured);
    });

    it("should use existing request ID from header", async () => {
      const existingId = "existing-request-id";
      let captured: string | undefined;
      const app = buildApp([requestIdMiddleware()], (c) => {
        captured = c.get("requestId");
      });

      const res = await app.request("/users", {
        headers: { "x-request-id": existingId },
      });

      expect(captured).toBe(existingId);
      expect(res.headers.get("X-Request-Id")).toBe(existingId);
    });
  });

  describe("timingMiddleware", () => {
    it("should record start time", async () => {
      let startTime: number | undefined;
      const app = buildApp([timingMiddleware()], (c) => {
        startTime = c.get("requestStartTime");
      });

      const res = await app.request("/users");

      expect(startTime).toBeDefined();
      expect(res.status).toBe(200);
    });
  });

  describe("observabilityMiddleware", () => {
    it("should combine request ID and timing", async () => {
      const config: ObservabilityConfig = {
        enableRequestId: true,
        enableTiming: true,
      };
      let requestId: string | undefined;
      let startTime: number | undefined;
      const app = buildApp([observabilityMiddleware(config)], (c) => {
        requestId = c.get("requestId");
        startTime = c.get("requestStartTime");
      });

      const res = await app.request("/users");

      expect(requestId).toBeDefined();
      expect(startTime).toBeDefined();
      expect(res.status).toBe(200);
    });

    it("should call onMetrics callback on response finish", async () => {
      const onMetrics = vi.fn();
      const config: ObservabilityConfig = {
        enableRequestId: true,
        enableTiming: true,
        onMetrics,
      };
      const app = buildApp([observabilityMiddleware(config)]);

      await app.request("/users");

      expect(onMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
          method: "GET",
          path: "/users",
          status: 200,
          duration: expect.any(Number),
        })
      );
    });

    it("should log slow queries when threshold exceeded", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config: ObservabilityConfig = {
        enableTiming: true,
        enableSlowQueryLog: true,
        slowQueryThresholdMs: 0, // Everything is slow
      };
      const app = buildApp([observabilityMiddleware(config)], async () => {
        // Small delay to ensure duration > 0
        await new Promise((r) => setTimeout(r, 1));
      });

      await app.request("/users");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should emit structured slow-query records through the global logger", async () => {
      const original = getLogger();
      const records: LogRecord[] = [];
      setLogger(createLogger({ level: "debug", sink: (r) => records.push(r) }));

      try {
        const app = buildApp(
          [
            observabilityMiddleware({
              enableTiming: true,
              enableSlowQueryLog: true,
              slowQueryThresholdMs: 0,
            }),
          ],
          async () => {
            await new Promise((r) => setTimeout(r, 1));
          }
        );

        await app.request("/users");
      } finally {
        setLogger(original);
      }

      const warn = records.find((r) => r.level === "warn");
      expect(warn).toBeDefined();
      expect(warn).toMatchObject({
        msg: "Slow request",
        method: "GET",
        path: "/users",
        status: 200,
      });
      expect(warn?.requestId).toEqual(expect.any(String));
      expect(warn?.durationMs).toEqual(expect.any(Number));
    });

    it("should propagate a trace id from traceparent header", async () => {
      let traceId: string | undefined;
      const app = buildApp([observabilityMiddleware()], (c) => {
        traceId = c.get("traceId");
      });

      const traceHex = "4bf92f3577b34da6a3ce929d0e0e4736";
      await app.request("/users", {
        headers: { traceparent: `00-${traceHex}-00f067aa0ba902b7-01` },
      });

      expect(traceId).toBe(traceHex);
    });

    it("should invoke onSpan with trace correlation info", async () => {
      const onSpan = vi.fn();
      const app = buildApp([observabilityMiddleware({ onSpan })]);

      await app.request("/users");

      expect(onSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
          traceId: expect.any(String),
          method: "GET",
          path: "/users",
        })
      );
    });
  });

  describe("resourceContextMiddleware", () => {
    it("should add resource context to request", async () => {
      let resource: string | undefined;
      const app = buildApp([resourceContextMiddleware("users")], (c) => {
        resource = c.get("resource");
      });

      const res = await app.request("/users");

      expect(resource).toBe("users");
      expect(res.status).toBe(200);
    });
  });

  describe("getRequestId", () => {
    it("should return request ID from request", async () => {
      const setId: MiddlewareHandler = async (c, next) => {
        c.set("requestId", "test-id");
        await next();
      };
      let result: string | undefined;
      const app = buildApp([setId], (c) => {
        result = getRequestId(c);
      });

      await app.request("/users");

      expect(result).toBe("test-id");
    });

    it("should return undefined if not set", async () => {
      let result: string | undefined = "sentinel";
      const app = buildApp([], (c) => {
        result = getRequestId(c);
      });

      await app.request("/users");

      expect(result).toBeUndefined();
    });
  });

  describe("getRequestDuration", () => {
    it("should calculate duration from start time", async () => {
      const setStart: MiddlewareHandler = async (c, next) => {
        c.set("requestStartTime", performance.now() - 1); // 1ms ago
        await next();
      };
      let duration: number | undefined;
      const app = buildApp([setStart], (c) => {
        duration = getRequestDuration(c);
      });

      await app.request("/users");

      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it("should return 0 if start time not set", async () => {
      let duration: number | undefined;
      const app = buildApp([], (c) => {
        duration = getRequestDuration(c);
      });

      await app.request("/users");

      expect(duration).toBe(0);
    });
  });

  describe("createMetricsCollector", () => {
    it("should collect metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });

      const metrics: RequestMetrics = {
        requestId: "test-1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      };

      collector.record(metrics);

      expect(collector.getRecent(10)).toHaveLength(1);
      expect(collector.getRecent(10)[0]).toEqual(metrics);
    });

    it("should limit stored metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 5 });

      for (let i = 0; i < 10; i++) {
        collector.record({
          requestId: `test-${i}`,
          method: "GET",
          path: "/users",
          resource: "users",
          operation: "list",
          status: 200,
          duration: 50,
          timestamp: Date.now(),
        });
      }

      expect(collector.getRecent(100)).toHaveLength(5);
    });

    it("should calculate statistics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });

      for (let i = 0; i < 5; i++) {
        collector.record({
          requestId: `test-${i}`,
          method: "GET",
          path: "/users",
          resource: "users",
          operation: "list",
          status: i < 4 ? 200 : 500,
          duration: 10 * (i + 1), // 10, 20, 30, 40, 50
          timestamp: Date.now(),
        });
      }

      const stats = collector.getStats();

      expect(stats.total).toBe(5);
      expect(stats.avgDuration).toBe(30);
      expect(stats.errorRate).toBe(0.2); // 1 out of 5
    });

    it("should filter by path", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });

      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });

      collector.record({
        requestId: "2",
        method: "GET",
        path: "/posts",
        resource: "posts",
        operation: "list",
        status: 200,
        duration: 30,
        timestamp: Date.now(),
      });

      const userMetrics = collector.getByPath("/users");

      expect(userMetrics).toHaveLength(1);
      expect(userMetrics[0].path).toBe("/users");
    });

    it("should filter slow requests", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });

      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });

      collector.record({
        requestId: "2",
        method: "GET",
        path: "/slow",
        resource: "slow",
        operation: "list",
        status: 200,
        duration: 1000,
        timestamp: Date.now(),
      });

      const slowRequests = collector.getSlow(100);

      expect(slowRequests).toHaveLength(1);
      expect(slowRequests[0].duration).toBe(1000);
    });

    it("should clear metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });

      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });

      collector.clear();

      expect(collector.getRecent(100)).toHaveLength(0);
    });
  });
});
