import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import { createAdminUI, AdminUIConfig } from "../src/ui/middleware";
import {
  setAdminAuditSink,
  logAdminAction,
  clearAdminAuditLog,
  type AdminAuditEntry,
} from "../src/ui/admin-auth";
import { get, post, patch, del } from "./helpers/hono";

const injectTestUser: MiddlewareHandler = async (c, next) => {
  c.set("user", {
    id: "test-user",
    email: "test@test.com",
    roles: ["admin"],
  } as any);
  await next();
};

describe("Admin UI Tests", () => {
  let app: Hono;

  const mockUsers = [
    { id: "1", email: "user1@test.com", name: "User 1" },
    { id: "2", email: "user2@test.com", name: "User 2" },
  ];

  const mockSessions = [
    { id: "sess-1", userId: "1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { id: "sess-2", userId: "2", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
  ];

  const config: AdminUIConfig = {
    title: "Test Admin",
    userManager: {
      listUsers: async (limit = 50, offset = 0) => ({
        users: mockUsers.slice(offset, offset + limit),
        total: mockUsers.length,
      }),
      getUser: async (id) => mockUsers.find(u => u.id === id) || null,
      createUser: async (data) => {
        const newUser = { id: String(mockUsers.length + 1), ...data };
        mockUsers.push(newUser);
        return newUser;
      },
      updateUser: async (id, data) => {
        const user = mockUsers.find(u => u.id === id);
        if (!user) throw new Error("User not found");
        Object.assign(user, data);
        return user;
      },
      deleteUser: async (id) => {
        const idx = mockUsers.findIndex(u => u.id === id);
        if (idx >= 0) mockUsers.splice(idx, 1);
      },
    },
    sessionManager: {
      listSessions: async () => mockSessions,
      getSessionsByUser: async (userId) => mockSessions.filter(s => s.userId === userId),
      createSession: async (userId, expiresIn = 86400) => ({
        token: `token-${Date.now()}`,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      }),
      revokeSession: async (sessionId) => {
        const idx = mockSessions.findIndex(s => s.id === sessionId);
        if (idx >= 0) mockSessions.splice(idx, 1);
      },
      revokeAllUserSessions: async (userId) => {
        const count = mockSessions.filter(s => s.userId === userId).length;
        mockSessions.splice(0, mockSessions.length, ...mockSessions.filter(s => s.userId !== userId));
        return count;
      },
    },
    dataExplorer: { enabled: true },
    kvInspector: { enabled: true },
    security: { mode: "development", auth: { disabled: true } },
  };

  beforeAll(() => {
    app = new Hono();
    app.use("*", injectTestUser);
    app.route("/__covara", createAdminUI(config));
  });

  describe("Full Page Routes", () => {
    it("should serve dashboard page", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Dashboard");
      expect(res.body).toContain("<!DOCTYPE html>");
      expect(res.body).toContain("htmx");
    });

    it("should serve resources page", async () => {
      const res = await get(app, "/__covara/ui/resources");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Resources");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve data explorer page", async () => {
      const res = await get(app, "/__covara/ui/data-explorer");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Data Explorer");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should mount the client-side data explorer app", async () => {
      const res = await get(app, "/__covara/ui/data-explorer");
      expect(res.body).toContain('id="dx-root"');
      expect(res.body).toContain("/__covara/ui/data-explorer-app.js");
    });

    it("should inject the command palette + runtime into the layout", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.body).toContain("window.__COVARA__");
      expect(res.body).toContain("/__covara/ui/covara-runtime.js");
      expect(res.body).toContain("cmdk-trigger");
    });

    it("renders nav icons as inline SVG (not font-dependent glyphs)", async () => {
      const res = await get(app, "/__covara/ui");
      // Each nav item's icon is an inline <svg class="ico">; the old Unicode
      // glyphs (e.g. ▦ ⛁ ⌛) must be gone.
      expect(res.body).toContain('<svg class="ico"');
      expect(res.body).toContain('class="nav-icon"');
      for (const glyph of ["▦", "⛁", "⌛", "☷", "⚿", "⇄"]) {
        expect(res.body).not.toContain(glyph);
      }
    });

    it("should serve the runtime JS asset as JavaScript", async () => {
      const res = await get(app, "/__covara/ui/covara-runtime.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
      expect(res.body).toContain("openPalette");
      expect(res.body).toContain("window.Covara");
    });

    it("should serve the data explorer app JS asset", async () => {
      const res = await get(app, "/__covara/ui/data-explorer-app.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
      expect(res.body).toContain("dx-root");
      expect(res.body).toContain("/api/explorer");
    });

    it("makes no external requests (no CDN hosts in the page)", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.body).not.toContain("unpkg.com");
      expect(res.body).not.toContain("rsms.me");
      // No external RESOURCE loads (scripts, stylesheets, fonts, images) — those
      // trigger network requests on render. Plain navigation links (e.g. an
      // <a href> to the docs site) are fine and don't fetch anything.
      expect(res.body).not.toMatch(/(?:src|@import|url\()\s*["'(]?https:\/\//);
      expect(res.body).not.toMatch(/<link\b[^>]*\bhref=["']https:\/\//);
      expect(res.body).toContain("/__covara/ui/htmx.js");
    });

    it("serves the logo and wires it as favicon + sidebar mark", async () => {
      const logo = await get(app, "/__covara/logo.svg");
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toContain("image/svg+xml");
      expect(logo.body).toContain("<svg");

      const page = await get(app, "/__covara/ui");
      expect(page.body).toContain('rel="icon"');
      expect(page.body).toContain("/__covara/logo.svg");
      expect(page.body).toContain("sidebar-logo-img");
    });

    it("serves htmx locally", async () => {
      const res = await get(app, "/__covara/ui/htmx.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
      expect(res.body).toContain("htmx");
    });

    it("sends a self-only CSP for the admin UI (overriding the strict API CSP)", async () => {
      const res = await get(app, "/__covara/ui");
      const csp = res.headers.get("content-security-policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
    });

    it("data explorer app ships the advanced tooling features", async () => {
      const res = await get(app, "/__covara/ui/data-explorer-app.js");
      const js = res.body as string;
      // selection + bulk delete, quick search, column menu, saved views,
      // export, inline editing, density.
      for (const marker of ["bulkDelete", "exportCSV", "exportJSON", "columnsMenu", "viewsMenu", "editCell", "dx-search", "compact"]) {
        expect(js).toContain(marker);
      }
    });

    it("should serve requests page", async () => {
      const res = await get(app, "/__covara/ui/requests");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Requests");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve errors page", async () => {
      const res = await get(app, "/__covara/ui/errors");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Errors");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve users page", async () => {
      const res = await get(app, "/__covara/ui/users");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Users");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve sessions page", async () => {
      const res = await get(app, "/__covara/ui/sessions");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Sessions");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve subscriptions page", async () => {
      const res = await get(app, "/__covara/ui/subscriptions");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Subscriptions");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve changelog page", async () => {
      const res = await get(app, "/__covara/ui/changelog");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Changelog");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve tasks page", async () => {
      const res = await get(app, "/__covara/ui/tasks");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Task Queue");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve kv-inspector page", async () => {
      const res = await get(app, "/__covara/ui/kv-inspector");
      expect(res.status).toBe(200);
      expect(res.body).toContain("KV Inspector");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve admin-audit page", async () => {
      const res = await get(app, "/__covara/ui/admin-audit");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Admin Audit");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve filter-tester page", async () => {
      const res = await get(app, "/__covara/ui/filter-tester");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Filter Tester");
      expect(res.body).toContain("<!DOCTYPE html>");
    });

    it("should serve api-explorer page", async () => {
      const res = await get(app, "/__covara/ui/api-explorer");
      expect(res.status).toBe(200);
      expect(res.body).toContain("API Explorer");
      expect(res.body).toContain("<!DOCTYPE html>");
    });
  });

  describe("HTMX Partial Routes", () => {
    it("should return content fragment for HTMX requests", async () => {
      const res = await get(app, "/__covara/ui/resources", {
        "HX-Request": "true",
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain("Resources");
      expect(res.body).not.toContain("<!DOCTYPE html>");
    });

    it("should return empty for /ui/empty", async () => {
      const res = await app.request("/__covara/ui/empty");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("should return request list partial", async () => {
      const res = await get(app, "/__covara/ui/requests/list");
      expect(res.status).toBe(200);
      expect(res.body).toContain("card");
    });

    it("should return users list partial", async () => {
      const res = await get(app, "/__covara/ui/users/list");
      expect(res.status).toBe(200);
      expect(res.body).toContain("user1@test.com");
    });

    it("should return sessions list partial", async () => {
      const res = await get(app, "/__covara/ui/sessions/list");
      expect(res.status).toBe(200);
      expect(res.body).toContain("sess-1");
    });

    it("should return subscriptions list partial", async () => {
      const res = await get(app, "/__covara/ui/subscriptions/list");
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });

    it("should return changelog list partial", async () => {
      const res = await get(app, "/__covara/ui/changelog/list");
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });

    it("should return audit list partial", async () => {
      const res = await get(app, "/__covara/ui/audit/list");
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  });

  describe("API Routes", () => {
    describe("User Management", () => {
      it("should list users", async () => {
        const res = await get(app, "/__covara/api/users");
        expect(res.status).toBe(200);
        expect(res.body.users).toBeDefined();
        expect(res.body.total).toBe(2);
        expect(res.body.enabled).toBe(true);
      });

      it("should get single user", async () => {
        const res = await get(app, "/__covara/api/users/1");
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe("user1@test.com");
      });

      it("should return 404 for non-existent user", async () => {
        const res = await get(app, "/__covara/api/users/999");
        expect(res.status).toBe(404);
      });

      it("should create user", async () => {
        const res = await post(app, "/__covara/api/users", {
          email: "new@test.com",
          name: "New User",
        });
        expect(res.status).toBe(201);
        expect(res.body.user.email).toBe("new@test.com");
      });

      it("should update user", async () => {
        const res = await patch(app, "/__covara/api/users/1", {
          name: "Updated Name",
        });
        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe("Updated Name");
      });

      it("should delete user", async () => {
        const initialCount = mockUsers.length;
        const res = await del(app, "/__covara/api/users/1");
        expect(res.status).toBe(204);
        expect(mockUsers.length).toBe(initialCount - 1);
      });
    });

    describe("Session Management", () => {
      it("should list sessions", async () => {
        const res = await get(app, "/__covara/api/sessions");
        expect(res.status).toBe(200);
        expect(res.body.sessions).toBeDefined();
        expect(res.body.enabled).toBe(true);
      });

      it("should get sessions by user", async () => {
        const res = await get(app, "/__covara/api/sessions/user/2");
        expect(res.status).toBe(200);
        expect(res.body.sessions).toBeDefined();
      });

      it("should create session", async () => {
        const res = await post(app, "/__covara/api/sessions", {
          userId: "2",
          expiresIn: 3600,
        });
        expect(res.status).toBe(201);
        expect(res.body.session.token).toBeDefined();
        expect(res.body.session.expiresAt).toBeDefined();
      });

      it("should require userId for session creation", async () => {
        const res = await post(app, "/__covara/api/sessions", {});
        expect(res.status).toBe(400);
      });

      it("should revoke session", async () => {
        const res = await del(app, "/__covara/api/sessions/sess-2");
        expect(res.status).toBe(204);
      });

      it("should revoke all user sessions", async () => {
        const res = await del(app, "/__covara/api/sessions/user/2");
        expect(res.status).toBe(200);
        expect(res.body.revokedCount).toBeDefined();
      });
    });

    describe("Resources API", () => {
      it("should return resources list", async () => {
        const res = await get(app, "/__covara/api/resources");
        expect(res.status).toBe(200);
        expect(res.body.resources).toBeDefined();
        expect(Array.isArray(res.body.resources)).toBe(true);
      });
    });

    describe("Environment API", () => {
      it("should return environment info", async () => {
        const res = await get(app, "/__covara/api/environment");
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe("development");
        expect(res.body.features).toBeDefined();
        expect(res.body.features.dataExplorer).toBe(true);
        expect(res.body.features.kvInspector).toBe(true);
      });
    });

    describe("Admin Audit API", () => {
      it("should return audit log", async () => {
        const res = await get(app, "/__covara/api/admin-audit");
        expect(res.status).toBe(200);
        expect(res.body.entries).toBeDefined();
        expect(res.body.mode).toBe("development");
      });

      it("should export audit log as JSON", async () => {
        const res = await get(app, "/__covara/api/admin-audit/export?format=json");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
      });

      it("should export audit log as CSV", async () => {
        const res = await get(app, "/__covara/api/admin-audit/export?format=csv");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/csv");
      });
    });

    describe("Problem Details", () => {
      it("should return problem documentation", async () => {
        const res = await get(app, "/__covara/problems/not-found");
        expect(res.status).toBe(200);
        expect(res.body.title).toBe("Resource Not Found");
        expect(res.body.description).toBeDefined();
        expect(res.body.solutions).toBeDefined();
      });

      it("should return unknown error for invalid type", async () => {
        const res = await get(app, "/__covara/problems/invalid-type");
        expect(res.status).toBe(200);
        expect(res.body.title).toBe("Unknown Error");
      });
    });
  });

  describe("Navigation", () => {
    it("should have correct active class for dashboard", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toMatch(/class="nav-item[^"]*active[^"]*"[^>]*href="[^"]*\/ui"/);
    });

    it("should have correct active class for resources", async () => {
      const res = await get(app, "/__covara/ui/resources");
      expect(res.status).toBe(200);
      expect(res.body).toMatch(/class="nav-item[^"]*active[^"]*"[^>]*href="[^"]*\/ui\/resources"/);
    });

    it("should include all navigation sections", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Overview");
      expect(res.body).toContain("Data");
      expect(res.body).toContain("Tools");
      expect(res.body).toContain("System");
    });

    it("should include all navigation items", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Dashboard");
      expect(res.body).toContain("Resources");
      expect(res.body).toContain("Requests");
      expect(res.body).toContain("Errors");
      expect(res.body).toContain("Data Explorer");
      expect(res.body).toContain("Admin Audit");
      expect(res.body).toContain("Filter Tester");
      expect(res.body).toContain("Subscriptions");
      expect(res.body).toContain("Changelog");
      expect(res.body).toContain("API Explorer");
      expect(res.body).toContain("Users");
      expect(res.body).toContain("Sessions");
      expect(res.body).toContain("Task Queue");
      expect(res.body).toContain("KV Inspector");
    });
  });

  describe("Theme Support", () => {
    it("should include theme toggle script", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain("toggleTheme");
      expect(res.body).toContain("data-theme");
    });

    it("should include dark mode CSS variables", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain('[data-theme="dark"]');
    });
  });

  describe("Environment Badge", () => {
    it("should show DEV badge in development mode", async () => {
      const res = await get(app, "/__covara/ui");
      expect(res.status).toBe(200);
      expect(res.body).toContain("DEV");
      expect(res.body).toContain("env-dev");
    });
  });
});

describe("Admin UI Without Managers", () => {
  let app: Hono;

  beforeAll(() => {
    app = new Hono();
    app.route("/__covara", createAdminUI({}));
  });

  it("should return empty users when no userManager", async () => {
    const res = await get(app, "/__covara/api/users");
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.enabled).toBe(false);
  });

  it("should return 501 for user operations without userManager", async () => {
    expect((await get(app, "/__covara/api/users/1")).status).toBe(501);
    expect((await post(app, "/__covara/api/users", {})).status).toBe(501);
    expect((await patch(app, "/__covara/api/users/1", {})).status).toBe(501);
    expect((await del(app, "/__covara/api/users/1")).status).toBe(501);
  });

  it("should return empty sessions when no sessionManager", async () => {
    const res = await get(app, "/__covara/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.enabled).toBe(false);
  });

  it("should return 501 for session operations without sessionManager", async () => {
    expect((await get(app, "/__covara/api/sessions/user/1")).status).toBe(501);
    expect((await post(app, "/__covara/api/sessions", {})).status).toBe(501);
    expect((await del(app, "/__covara/api/sessions/1")).status).toBe(501);
    expect((await del(app, "/__covara/api/sessions/user/1")).status).toBe(501);
  });

  it("should still serve UI pages", async () => {
    const res = await get(app, "/__covara/ui");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Dashboard");
  });

  it("should show disabled KV inspector when not configured", async () => {
    const res = await get(app, "/__covara/ui/kv-inspector");
    expect(res.status).toBe(200);
    expect(res.body).toContain("KV Inspector Disabled");
  });
});

describe("Admin UI App-Auth Gating", () => {
  const injectUser = (user: any): MiddlewareHandler => async (c, next) => {
    if (user !== null) c.set("user", user as any);
    await next();
  };

  const buildApp = (security: any, user: any) => {
    const app = new Hono();
    if (user !== undefined) app.use("*", injectUser(user));
    app.route("/__covara", createAdminUI({ security }));
    return app;
  };

  it("denies anonymous access to UI pages when requireRole is set (401)", async () => {
    const app = buildApp({ mode: "production", requireRole: "admin" }, null);
    const res = await get(app, "/__covara/ui");
    expect(res.status).toBe(401);
  });

  it("denies an unauthorized logged-in user (403)", async () => {
    const app = buildApp(
      { mode: "production", requireRole: "admin" },
      { id: "u1", email: "u1@test.com", roles: ["viewer"] }
    );
    const res = await get(app, "/__covara/ui");
    expect(res.status).toBe(403);
  });

  it("allows an authorized logged-in user", async () => {
    const app = buildApp(
      { mode: "production", requireRole: "admin" },
      { id: "u1", email: "u1@test.com", roles: ["admin"] }
    );
    const res = await get(app, "/__covara/ui");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Dashboard");
  });

  it("gates JSON API routes with the same check", async () => {
    const denied = buildApp({ mode: "production", requireRole: "admin" }, null);
    expect((await get(denied, "/__covara/api/resources")).status).toBe(401);

    const allowed = buildApp(
      { mode: "production", requireRole: "admin" },
      { id: "u1", email: "u1@test.com", roles: ["admin"] }
    );
    expect((await get(allowed, "/__covara/api/resources")).status).toBe(200);
  });

  it("fails closed in production with no auth configured", async () => {
    const app = buildApp({ mode: "production" }, undefined);
    expect((await get(app, "/__covara/ui")).status).toBe(401);
    expect((await get(app, "/__covara/api/resources")).status).toBe(401);
  });

  it("falls back to env-style apiKey when no app auth is configured", async () => {
    const app = buildApp({ mode: "production", auth: { apiKey: "secret" } }, undefined);
    expect((await get(app, "/__covara/api/resources")).status).toBe(401);
    expect(
      (await get(app, "/__covara/api/resources", { "X-Admin-API-Key": "secret" })).status
    ).toBe(200);
  });
});

describe("Admin UI Audit Sink + Export", () => {
  afterEach(() => {
    setAdminAuditSink(null);
    clearAdminAuditLog();
  });

  it("registers the configured auditSink and forwards entries", () => {
    const received: AdminAuditEntry[] = [];
    const app = new Hono();
    app.route(
      "/__covara",
      createAdminUI({
        security: {
          mode: "development",
          auth: { disabled: true },
          auditSink: (e) => {
            received.push(e);
          },
        },
      })
    );

    logAdminAction({ userId: "u1", userEmail: "u1@test.com", operation: "delete" });
    expect(received).toHaveLength(1);
    expect(received[0].operation).toBe("delete");
  });

  it("serves the JSON audit export endpoint gated by authz", async () => {
    const app = new Hono();
    app.route(
      "/__covara",
      createAdminUI({ security: { mode: "development", auth: { disabled: true } } })
    );

    logAdminAction({ userId: "u1", userEmail: "u1@test.com", operation: "create" });

    const res = await get(app, "/__covara/admin/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("audit-log.json");
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.some((e: any) => e.operation === "create")).toBe(true);
  });

  it("denies the export endpoint to anonymous users when authz is required", async () => {
    const app = new Hono();
    app.route(
      "/__covara",
      createAdminUI({ security: { mode: "production", requireRole: "admin" } })
    );
    const res = await get(app, "/__covara/admin/audit/export");
    expect(res.status).toBe(401);
  });
});
