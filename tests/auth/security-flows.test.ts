import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { useAuth, AuthUser } from "@/auth/routes";
import { createPassportAdapter, PassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore } from "@/auth/types";
import { InMemoryVerificationTokenStore } from "@/auth/verification";
import { hashPassword, verifyPassword } from "@/auth/password";
import { createTestApp, get, post } from "../helpers/hono";

const setCookies = (response: Response): string[] => response.headers.getSetCookie();

const cookieValue = (cookies: string[], name: string): string | undefined => {
  const c = cookies.find((x) => x.startsWith(`${name}=`));
  if (!c) return undefined;
  return c.split(";")[0].split("=").slice(1).join("=");
};

describe("Auth Security Flows", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let users: Map<string, AuthUser & { passwordHash: string; emailVerified?: Date | null }>;

  beforeEach(() => {
    app = createTestApp();
    sessionStore = new InMemorySessionStore();
    users = new Map();
    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const u = users.get(id);
        return u ? { id: u.id, email: u.email, name: u.name, image: null } : null;
      },
      sessionStore,
    });
  });

  describe("CSRF protection", () => {
    beforeEach(() => {
      const { router } = useAuth({ adapter: authAdapter, csrf: true });
      router.post("/echo", (c) => c.json({ ok: true }));
      router.get("/safe", (c) => c.json({ ok: true }));
      app.route("/api/auth", router);
    });

    it("rejects an unsafe cookie request without a token", async () => {
      const res = await post(app, "/api/auth/echo", {}, { cookie: "session=abc" });
      expect(res.status).toBe(403);
    });

    it("accepts an unsafe cookie request with a matching token", async () => {
      const safe = await get(app, "/api/auth/safe");
      const token = cookieValue(setCookies(safe.res), "csrf_token");
      expect(token).toBeDefined();

      const res = await post(app, "/api/auth/echo", {}, {
        cookie: `session=abc; csrf_token=${token}`,
        "x-csrf-token": token!,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects when header token does not match cookie token", async () => {
      const res = await post(app, "/api/auth/echo", {}, {
        cookie: "session=abc; csrf_token=cookie-token",
        "x-csrf-token": "different-token",
      });
      expect(res.status).toBe(403);
    });

    it("exempts bearer-token requests from CSRF checks", async () => {
      const res = await post(app, "/api/auth/echo", {}, {
        authorization: "Bearer some-token",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("Login lockout", () => {
    beforeEach(() => {
      users.set("u1", {
        id: "u1",
        email: "lock@example.com",
        name: "Lock",
        passwordHash: "secret",
      });
      const { router } = useAuth({
        adapter: authAdapter,
        throttle: { maxAttempts: 3, windowMs: 60_000 },
        login: {
          validateCredentials: async (email, password) => {
            for (const u of users.values()) {
              if (u.email === email && u.passwordHash === password) {
                return { id: u.id, email: u.email, name: u.name };
              }
            }
            return null;
          },
        },
      });
      app.route("/api/auth", router);
    });

    it("returns 429 after N failed attempts", async () => {
      const headers = { "x-forwarded-for": "9.9.9.9" };
      for (let i = 0; i < 3; i++) {
        const r = await post(
          app,
          "/api/auth/login",
          { email: "lock@example.com", password: "wrong" },
          headers
        );
        expect(r.status).toBe(401);
      }
      const locked = await post(
        app,
        "/api/auth/login",
        { email: "lock@example.com", password: "wrong" },
        headers
      );
      expect(locked.status).toBe(429);

      const lockedCorrect = await post(
        app,
        "/api/auth/login",
        { email: "lock@example.com", password: "secret" },
        headers
      );
      expect(lockedCorrect.status).toBe(429);
    });

    it("allows login before the threshold is reached", async () => {
      const headers = { "x-forwarded-for": "1.2.3.4" };
      await post(app, "/api/auth/login", { email: "lock@example.com", password: "wrong" }, headers);
      const ok = await post(
        app,
        "/api/auth/login",
        { email: "lock@example.com", password: "secret" },
        headers
      );
      expect(ok.status).toBe(200);
    });
  });

  describe("Email verification flow", () => {
    let store: InMemoryVerificationTokenStore;
    let sent: { identifier: string; token: string } | null;

    beforeEach(() => {
      store = new InMemoryVerificationTokenStore();
      sent = null;
      users.set("u1", {
        id: "u1",
        email: "verify@example.com",
        name: "V",
        passwordHash: "x",
        emailVerified: null,
      });
      const { router } = useAuth({
        adapter: authAdapter,
        verification: {
          store,
          sendToken: async ({ identifier, token }) => {
            sent = { identifier, token };
          },
          markVerified: async (identifier) => {
            for (const u of users.values()) {
              if (u.email === identifier) u.emailVerified = new Date();
            }
          },
          ttlMs: 1000,
        },
      });
      app.route("/api/auth", router);
    });

    it("completes a round-trip and marks emailVerified", async () => {
      const reqRes = await post(app, "/api/auth/verify/request", {
        email: "verify@example.com",
      });
      expect(reqRes.status).toBe(200);
      expect(sent).not.toBeNull();

      const confirmRes = await post(app, "/api/auth/verify/confirm", {
        email: "verify@example.com",
        token: sent!.token,
      });
      expect(confirmRes.status).toBe(200);
      expect(users.get("u1")!.emailVerified).toBeInstanceOf(Date);
    });

    it("rejects a bad token", async () => {
      await post(app, "/api/auth/verify/request", { email: "verify@example.com" });
      const res = await post(app, "/api/auth/verify/confirm", {
        email: "verify@example.com",
        token: "not-the-token",
      });
      expect(res.status).toBe(400);
      expect(users.get("u1")!.emailVerified).toBeNull();
    });

    it("rejects an expired token", async () => {
      await post(app, "/api/auth/verify/request", { email: "verify@example.com" });
      const realToken = sent!.token;

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 5000);
      try {
        const res = await post(app, "/api/auth/verify/confirm", {
          email: "verify@example.com",
          token: realToken,
        });
        expect(res.status).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Password reset flow", () => {
    let store: InMemoryVerificationTokenStore;
    let sent: { identifier: string; token: string } | null;

    beforeEach(async () => {
      store = new InMemoryVerificationTokenStore();
      sent = null;
      users.set("u1", {
        id: "u1",
        email: "reset@example.com",
        name: "R",
        passwordHash: await hashPassword("oldpassword"),
      });
      const { router } = useAuth({
        adapter: authAdapter,
        passwordReset: {
          store,
          sendToken: async ({ identifier, token }) => {
            sent = { identifier, token };
          },
          findUserByEmail: async (email) => {
            for (const u of users.values()) {
              if (u.email === email) return { id: u.id };
            }
            return null;
          },
          resetPassword: async (email, passwordHash) => {
            for (const u of users.values()) {
              if (u.email === email) u.passwordHash = passwordHash;
            }
          },
        },
        login: {
          validateCredentials: async (email, password) => {
            for (const u of users.values()) {
              if (u.email === email && (await verifyPassword(password, u.passwordHash))) {
                return { id: u.id, email: u.email, name: u.name };
              }
            }
            return null;
          },
        },
      });
      app.route("/api/auth", router);
    });

    it("changes the password and invalidates the old one", async () => {
      const forgot = await post(app, "/api/auth/password/forgot", {
        email: "reset@example.com",
      });
      expect(forgot.status).toBe(200);
      expect(sent).not.toBeNull();

      const reset = await post(app, "/api/auth/password/reset", {
        email: "reset@example.com",
        token: sent!.token,
        password: "newpassword",
      });
      expect(reset.status).toBe(200);

      const oldLogin = await post(app, "/api/auth/login", {
        email: "reset@example.com",
        password: "oldpassword",
      });
      expect(oldLogin.status).toBe(401);

      const newLogin = await post(app, "/api/auth/login", {
        email: "reset@example.com",
        password: "newpassword",
      });
      expect(newLogin.status).toBe(200);
    });

    it("returns identical responses for known and unknown emails", async () => {
      const known = await post(app, "/api/auth/password/forgot", {
        email: "reset@example.com",
      });
      const knownSent = sent;
      sent = null;

      const unknown = await post(app, "/api/auth/password/forgot", {
        email: "nobody@example.com",
      });

      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
      expect(knownSent).not.toBeNull();
      expect(sent).toBeNull();
    });

    it("rejects reset with a bad token", async () => {
      await post(app, "/api/auth/password/forgot", { email: "reset@example.com" });
      const res = await post(app, "/api/auth/password/reset", {
        email: "reset@example.com",
        token: "bad-token",
        password: "newpassword",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Session rotation on login", () => {
    beforeEach(() => {
      users.set("u1", {
        id: "u1",
        email: "rotate@example.com",
        name: "Rot",
        passwordHash: "secret",
      });
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        login: {
          validateCredentials: async (email, password) => {
            for (const u of users.values()) {
              if (u.email === email && u.passwordHash === password) {
                return { id: u.id, email: u.email, name: u.name };
              }
            }
            return null;
          },
        },
      });
      app.route("/api/auth", router);
      app.use("*", middleware);
    });

    it("invalidates a pre-existing session id presented on login", async () => {
      const fixated = await authAdapter.createSession("u1");

      const res = await post(
        app,
        "/api/auth/login",
        { email: "rotate@example.com", password: "secret" },
        { cookie: `session=${fixated.id}` }
      );
      expect(res.status).toBe(200);
      expect(res.body.sessionId).not.toBe(fixated.id);

      const oldStillValid = await get(app, "/api/auth/me", {
        cookie: `session=${fixated.id}`,
      });
      expect(oldStillValid.body.user).toBeNull();
    });
  });
});
