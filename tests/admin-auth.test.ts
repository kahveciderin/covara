import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createAdminAuthMiddleware,
  logAdminAction,
  getAdminAuditLog,
  clearAdminAuditLog,
  setAdminAuditSink,
  extractUserRoles,
  getAdminUser,
  detectEnvironment,
  type AdminAuditEntry,
} from "../src/ui/admin-auth";
import { get } from "./helpers/hono";

const injectAppUser = (user: any) => async (c: any, next: any) => {
  if (user !== null) c.set("user", user);
  await next();
};

describe("Admin Auth", () => {
  let app: Hono;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    app = new Hono();
    clearAdminAuditLog();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe("detectEnvironment", () => {
    it("returns development for no NODE_ENV", () => {
      delete process.env.NODE_ENV;
      expect(detectEnvironment()).toBe("development");
    });

    it("returns production for NODE_ENV=production", () => {
      process.env.NODE_ENV = "production";
      expect(detectEnvironment()).toBe("production");
    });

    it("returns staging for NODE_ENV=staging", () => {
      process.env.NODE_ENV = "staging";
      expect(detectEnvironment()).toBe("staging");
    });
  });

  describe("createAdminAuthMiddleware", () => {
    it("allows access in development mode without auth", async () => {
      process.env.NODE_ENV = "development";

      const middleware = createAdminAuthMiddleware({ mode: "development" });
      app.use("*", middleware);
      app.get("/test", (c) => {
        const user = getAdminUser(c);
        return c.json({ user });
      });

      const res = await get(app, "/test");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
    });

    it("requires auth in production mode", async () => {
      const middleware = createAdminAuthMiddleware({ mode: "production" });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await get(app, "/test");
      expect(res.status).toBe(401);
    });

    it("allows access with valid API key", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use("*", middleware);
      app.get("/test", (c) => {
        const user = getAdminUser(c);
        return c.json({ user });
      });

      const res = await get(app, "/test", { "X-Admin-API-Key": "secret-key" });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("api-key");
    });

    it("allows access with Bearer token", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use("*", middleware);
      app.get("/test", (c) => {
        const user = getAdminUser(c);
        return c.json({ user });
      });

      const res = await get(app, "/test", {
        Authorization: "Bearer secret-key",
      });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("api-key");
    });

    it("rejects invalid API key", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await get(app, "/test", { "X-Admin-API-Key": "wrong-key" });
      expect(res.status).toBe(401);
    });

    it("allows access when auth is disabled", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "development",
        auth: { disabled: true },
      });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await get(app, "/test");
      expect(res.status).toBe(200);
    });

    it("enforces IP allowlist in production", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { disabled: true },
        allowedIPs: ["192.168.1.1"],
      });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await get(app, "/test", { "X-Forwarded-For": "10.0.0.1" });
      expect(res.status).toBe(403);
    });

    it("enforces required role", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: {
          authenticate: async () => ({
            id: "user1",
            email: "user@test.com",
            roles: ["viewer"],
          }),
        },
        authorization: { requiredRole: "admin" },
      });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await get(app, "/test");
      expect(res.status).toBe(403);
    });

    it("uses custom authenticate function", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: {
          authenticate: async () => ({
            id: "custom",
            email: "custom@test.com",
            roles: ["admin"],
          }),
        },
      });
      app.use("*", middleware);
      app.get("/test", (c) => {
        const user = getAdminUser(c);
        return c.json({ user });
      });

      const res = await get(app, "/test");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("custom");
    });

    it("enforces rate limit", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "development",
        auth: { disabled: true },
        rateLimit: { windowMs: 1000, maxRequests: 2 },
      });
      app.use("*", middleware);
      app.get("/test", (c) => c.json({ ok: true }));

      await get(app, "/test");
      await get(app, "/test");
      const res = await get(app, "/test");
      expect(res.status).toBe(429);
    });
  });

  describe("App auth integration (authorize / requireRole)", () => {
    const buildApp = (config: any, user: any) => {
      const a = new Hono();
      a.use("*", injectAppUser(user));
      a.use("*", createAdminAuthMiddleware(config));
      a.get("/test", (c) => c.json({ user: getAdminUser(c) }));
      return a;
    };

    it("allows a logged-in authorized user via authorize()", async () => {
      const a = buildApp(
        { mode: "production", authorize: (u: any) => u.email === "ok@test.com" },
        { id: "u1", email: "ok@test.com" }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("u1");
    });

    it("denies anonymous with 401 when authorize is configured", async () => {
      const a = buildApp({ mode: "production", authorize: () => true }, null);
      const res = await get(a, "/test");
      expect(res.status).toBe(401);
    });

    it("denies unauthorized logged-in user with 403", async () => {
      const a = buildApp(
        { mode: "production", authorize: () => false },
        { id: "u1", email: "u1@test.com" }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(403);
    });

    it("requireRole allows a user with the role (from user.roles)", async () => {
      const a = buildApp(
        { mode: "production", requireRole: "admin" },
        { id: "u1", email: "u1@test.com", roles: ["admin"] }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
    });

    it("requireRole denies a user without the role with 403", async () => {
      const a = buildApp(
        { mode: "production", requireRole: "admin" },
        { id: "u1", email: "u1@test.com", roles: ["viewer"] }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(403);
    });

    it("requireRole denies anonymous with 401", async () => {
      const a = buildApp({ mode: "production", requireRole: "admin" }, null);
      const res = await get(a, "/test");
      expect(res.status).toBe(401);
    });

    it("requireRole accepts an array of allowed roles", async () => {
      const a = buildApp(
        { mode: "production", requireRole: ["superadmin", "admin"] },
        { id: "u1", email: "u1@test.com", roles: ["admin"] }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
    });

    it("finds roles in user.role (singular)", async () => {
      const a = buildApp(
        { mode: "production", requireRole: "admin" },
        { id: "u1", email: "u1@test.com", role: "admin" }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
    });

    it("finds roles in user.metadata.roles", async () => {
      const a = buildApp(
        { mode: "production", requireRole: "admin" },
        { id: "u1", email: "u1@test.com", metadata: { roles: ["admin"] } }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
    });

    it("finds roles in user.metadata.role (singular)", async () => {
      const a = buildApp(
        { mode: "production", requireRole: "admin" },
        { id: "u1", email: "u1@test.com", metadata: { role: "admin" } }
      );
      const res = await get(a, "/test");
      expect(res.status).toBe(200);
    });
  });

  describe("Fail-closed in production", () => {
    it("denies access in production when no auth is configured", async () => {
      const a = new Hono();
      a.use("*", createAdminAuthMiddleware({ mode: "production" }));
      a.get("/test", (c) => c.json({ ok: true }));
      const res = await get(a, "/test");
      expect(res.status).toBe(401);
    });

    it("denies access in production even with a logged-in user when nothing is configured", async () => {
      const a = new Hono();
      a.use("*", injectAppUser({ id: "u1", email: "u1@test.com", roles: ["admin"] }));
      a.use("*", createAdminAuthMiddleware({ mode: "production" }));
      a.get("/test", (c) => c.json({ ok: true }));
      const res = await get(a, "/test");
      expect(res.status).toBe(401);
    });
  });

  describe("extractUserRoles", () => {
    it("merges roles from all known locations", () => {
      const roles = extractUserRoles({
        roles: ["a"],
        role: "b",
        metadata: { roles: ["c"], role: "d" },
      } as any);
      expect(roles.sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("returns empty array for null user", () => {
      expect(extractUserRoles(null)).toEqual([]);
    });
  });

  describe("Audit sink", () => {
    afterEach(() => {
      setAdminAuditSink(null);
    });

    it("forwards logged entries to a configured sink", () => {
      const received: AdminAuditEntry[] = [];
      setAdminAuditSink((e) => {
        received.push(e);
      });
      logAdminAction({ userId: "u1", userEmail: "u1@test.com", operation: "delete" });
      expect(received).toHaveLength(1);
      expect(received[0].operation).toBe("delete");
      expect(received[0].timestamp).toBeDefined();
    });

    it("does not let a throwing sink break logging", () => {
      setAdminAuditSink(() => {
        throw new Error("sink boom");
      });
      expect(() =>
        logAdminAction({ userId: "u1", userEmail: "u1@test.com", operation: "x" })
      ).not.toThrow();
      expect(getAdminAuditLog()[0].operation).toBe("x");
    });
  });

  describe("Admin Audit Log", () => {
    it("logs admin actions", () => {
      logAdminAction({
        userId: "user-1",
        userEmail: "admin@test.com",
        operation: "test_operation",
        reason: "Testing",
      });

      const log = getAdminAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].userId).toBe("user-1");
      expect(log[0].operation).toBe("test_operation");
      expect(log[0].timestamp).toBeDefined();
    });

    it("supports pagination", () => {
      for (let i = 0; i < 10; i++) {
        logAdminAction({
          userId: `user-${i}`,
          userEmail: `admin${i}@test.com`,
          operation: "test",
        });
      }

      const page1 = getAdminAuditLog(3, 0);
      expect(page1).toHaveLength(3);

      const page2 = getAdminAuditLog(3, 3);
      expect(page2).toHaveLength(3);
      expect(page2[0].userId).not.toBe(page1[0].userId);
    });

    it("maintains order (newest first)", () => {
      logAdminAction({ userId: "first", userEmail: "a@t.com", operation: "a" });
      logAdminAction({ userId: "second", userEmail: "b@t.com", operation: "b" });

      const log = getAdminAuditLog();
      expect(log[0].userId).toBe("second");
      expect(log[1].userId).toBe("first");
    });

    it("clears the log", () => {
      logAdminAction({ userId: "test", userEmail: "t@t.com", operation: "test" });
      expect(getAdminAuditLog()).toHaveLength(1);

      clearAdminAuditLog();
      expect(getAdminAuditLog()).toHaveLength(0);
    });

    it("includes before/after values for mutations", () => {
      logAdminAction({
        userId: "admin",
        userEmail: "admin@test.com",
        operation: "update",
        resource: "users",
        resourceId: "123",
        beforeValue: { name: "Old" },
        afterValue: { name: "New" },
      });

      const log = getAdminAuditLog();
      expect(log[0].beforeValue).toEqual({ name: "Old" });
      expect(log[0].afterValue).toEqual({ name: "New" });
    });
  });
});
