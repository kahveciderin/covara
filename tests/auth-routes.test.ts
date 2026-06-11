import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono, type Context } from "hono";
import { useAuth, AuthUser, UseAuthOptions } from "@/auth/routes";
import { createPassportAdapter, PassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore } from "@/auth/types";
import { createTestApp, get, post } from "./helpers/hono";

const makeContext = async (
  headers: Record<string, string> = {}
): Promise<Context> => {
  let captured: Context | undefined;
  const probe = new Hono();
  probe.get("*", (c) => {
    captured = c;
    return c.text("ok");
  });
  await probe.request("/", { headers });
  if (!captured) throw new Error("Failed to capture context");
  return captured;
};

const setCookies = (response: Response): string[] =>
  response.headers.getSetCookie();

describe("Auth Routes (useAuth)", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let mockUsers: Map<string, AuthUser & { passwordHash: string }>;

  const createTestUser = (id: string, email: string, password: string, name: string) => ({
    id,
    email,
    name,
    passwordHash: password,
  });

  beforeEach(() => {
    app = createTestApp();

    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("user-1", createTestUser("user-1", "test@example.com", "password123", "Test User"));

    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const user = mockUsers.get(id);
        if (!user) return null;
        return { id: user.id, email: user.email, name: user.name, image: null };
      },
      sessionStore,
    });
  });

  describe("GET /me", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.route("/api/auth", router);
      app.use("*", middleware);
    });

    it("should return null when not authenticated", async () => {
      const res = await get(app, "/api/auth/me");

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return user when authenticated via session cookie", async () => {
      const session = await authAdapter.createSession("user-1");

      const res = await get(app, "/api/auth/me", {
        cookie: `session=${session.id}`,
      });

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.id).toBe("user-1");
      expect(res.body.user.email).toBe("test@example.com");
      expect(res.body.expiresAt).toBeDefined();
    });

    it("should return null for expired session", async () => {
      const session = await authAdapter.createSession("user-1");
      await authAdapter.invalidateSession(session.id);

      const res = await get(app, "/api/auth/me", {
        cookie: `session=${session.id}`,
      });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return null for invalid session ID", async () => {
      const res = await get(app, "/api/auth/me", {
        cookie: "session=invalid-session-id",
      });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return null when user no longer exists", async () => {
      const session = await authAdapter.createSession("user-1");
      mockUsers.delete("user-1");

      const res = await get(app, "/api/auth/me", {
        cookie: `session=${session.id}`,
      });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });
  });

  describe("POST /login", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        login: {
          validateCredentials: async (email, password) => {
            for (const user of mockUsers.values()) {
              if (user.email === email && user.passwordHash === password) {
                return { id: user.id, email: user.email, name: user.name };
              }
            }
            return null;
          },
        },
      });
      app.route("/api/auth", router);
      app.use("*", middleware);
    });

    it("should login with valid credentials and set session cookie", async () => {
      const res = await post(app, "/api/auth/login", {
        email: "test@example.com",
        password: "password123",
      });

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.id).toBe("user-1");
      expect(res.body.sessionId).toBeDefined();

      const cookies = setCookies(res.res);
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies.some((c) => c.startsWith("session="))).toBe(true);
    });

    it("should reject login with invalid email", async () => {
      const res = await post(app, "/api/auth/login", {
        email: "wrong@example.com",
        password: "password123",
      });

      expect(res.status).toBe(401);
      expect(res.body.detail).toContain("Invalid");
    });

    it("should reject login with invalid password", async () => {
      const res = await post(app, "/api/auth/login", {
        email: "test@example.com",
        password: "wrongpassword",
      });

      expect(res.status).toBe(401);
      expect(res.body.detail).toContain("Invalid");
    });

    it("should reject login with missing email", async () => {
      const res = await post(app, "/api/auth/login", {
        password: "password123",
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("required");
    });

    it("should reject login with missing password", async () => {
      const res = await post(app, "/api/auth/login", {
        email: "test@example.com",
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("required");
    });

    it("should allow authenticated request after login using session cookie", async () => {
      const loginRes = await post(app, "/api/auth/login", {
        email: "test@example.com",
        password: "password123",
      });

      const sessionCookie = setCookies(loginRes.res).find((c) =>
        c.startsWith("session=")
      );
      expect(sessionCookie).toBeDefined();

      const meRes = await get(app, "/api/auth/me", { cookie: sessionCookie! });

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).not.toBeNull();
      expect(meRes.body.user.id).toBe("user-1");
    });
  });

  describe("POST /signup", () => {
    let userIdCounter = 10;

    beforeEach(() => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        signup: {
          createUser: async ({ email, password, name }) => {
            const id = `user-${userIdCounter++}`;
            const newUser = createTestUser(id, email, password, name ?? "New User");
            mockUsers.set(id, newUser);
            return { id, email, name: name ?? "New User" };
          },
          validateEmail: (email) => email.includes("@"),
          validatePassword: (password) => password.length >= 6,
        },
      });
      app.route("/api/auth", router);
      app.use("*", middleware);
    });

    it("should create user and set session cookie", async () => {
      const res = await post(app, "/api/auth/signup", {
        email: "new@example.com",
        password: "newpassword123",
        name: "New User",
      });

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.email).toBe("new@example.com");

      const cookies = setCookies(res.res);
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies.some((c) => c.startsWith("session="))).toBe(true);
    });

    it("should reject signup with invalid email", async () => {
      const res = await post(app, "/api/auth/signup", {
        email: "invalidemail",
        password: "password123",
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("email");
    });

    it("should reject signup with weak password", async () => {
      const res = await post(app, "/api/auth/signup", {
        email: "new@example.com",
        password: "123",
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("Password");
    });

    it("should reject signup with missing fields", async () => {
      const res = await post(app, "/api/auth/signup", {
        email: "new@example.com",
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("required");
    });

    it("should allow authenticated request after signup using session cookie", async () => {
      const signupRes = await post(app, "/api/auth/signup", {
        email: "new@example.com",
        password: "newpassword123",
        name: "New User",
      });

      const sessionCookie = setCookies(signupRes.res).find((c) =>
        c.startsWith("session=")
      );
      expect(sessionCookie).toBeDefined();

      const meRes = await get(app, "/api/auth/me", { cookie: sessionCookie! });

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).not.toBeNull();
      expect(meRes.body.user.email).toBe("new@example.com");
    });
  });

  describe("POST /logout", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.route("/api/auth", router);
      app.use("*", middleware);
    });

    it("should clear session and return success", async () => {
      const session = await authAdapter.createSession("user-1");

      const res = await post(app, "/api/auth/logout", undefined, {
        cookie: `session=${session.id}`,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const cookies = setCookies(res.res);
      expect(cookies.length).toBeGreaterThan(0);
      const sessionCookie = cookies.find((c) => c.startsWith("session="));
      expect(sessionCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    });

    it("should invalidate session so subsequent requests fail", async () => {
      const session = await authAdapter.createSession("user-1");

      await post(app, "/api/auth/logout", undefined, {
        cookie: `session=${session.id}`,
      });

      const meRes = await get(app, "/api/auth/me", {
        cookie: `session=${session.id}`,
      });

      expect(meRes.body.user).toBeNull();
    });

    it("should succeed even when not authenticated", async () => {
      const res = await post(app, "/api/auth/logout");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Lifecycle hooks", () => {
    it("should call onLogin hook after successful login", async () => {
      const onLogin = vi.fn();

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        login: {
          validateCredentials: async (email, password) => {
            const user = mockUsers.get("user-1");
            if (user && user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
            return null;
          },
        },
        onLogin,
      });
      app.route("/api/auth", router);
      app.use("*", middleware);

      await post(app, "/api/auth/login", {
        email: "test@example.com",
        password: "password123",
      });

      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin.mock.calls[0][0].id).toBe("user-1");
    });

    it("should call onLogout hook after logout", async () => {
      const onLogout = vi.fn();

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        onLogout,
      });
      app.route("/api/auth", router);
      app.use("*", middleware);

      const session = await authAdapter.createSession("user-1");

      await post(app, "/api/auth/logout", undefined, {
        cookie: `session=${session.id}`,
      });

      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(onLogout.mock.calls[0][0]?.id).toBe("user-1");
    });

    it("should call onSignup hook after successful signup", async () => {
      const onSignup = vi.fn();
      let userIdCounter = 20;

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        signup: {
          createUser: async ({ email, password, name }) => {
            const id = `user-${userIdCounter++}`;
            mockUsers.set(id, createTestUser(id, email, password, name ?? "New User"));
            return { id, email, name: name ?? "New User" };
          },
        },
        onSignup,
      });
      app.route("/api/auth", router);
      app.use("*", middleware);

      await post(app, "/api/auth/signup", {
        email: "hook@example.com",
        password: "password123",
        name: "Hook User",
      });

      expect(onSignup).toHaveBeenCalledTimes(1);
      expect(onSignup.mock.calls[0][0].email).toBe("hook@example.com");
    });
  });

  describe("Custom cookie configuration", () => {
    it("should use custom cookie name", async () => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        cookieName: "auth_session",
        login: {
          validateCredentials: async (email, password) => {
            const user = mockUsers.get("user-1");
            if (user && user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
            return null;
          },
        },
      });
      app.route("/api/auth", router);
      app.use("*", middleware);

      const res = await post(app, "/api/auth/login", {
        email: "test@example.com",
        password: "password123",
      });

      const cookies = setCookies(res.res);
      expect(cookies.some((c) => c.startsWith("auth_session="))).toBe(true);
    });
  });

  describe("Custom user serialization", () => {
    it("should use custom serializeUser function", async () => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        serializeUser: (user) => ({
          userId: user.id,
          displayName: user.name,
        }),
      });
      app.route("/api/auth", router);
      app.use("*", middleware);

      const session = await authAdapter.createSession("user-1");

      const res = await get(app, "/api/auth/me", {
        cookie: `session=${session.id}`,
      });

      expect(res.body.user.userId).toBe("user-1");
      expect(res.body.user.displayName).toBe("Test User");
      expect(res.body.user.id).toBeUndefined();
    });
  });

  describe("Middleware integration", () => {
    it("should populate the user context on authenticated requests", async () => {
      let capturedUser: any = null;

      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.route("/api/auth", router);
      app.use("*", middleware);
      app.get("/test", (c) => {
        capturedUser = c.get("user") ?? null;
        return c.json({ hasUser: !!c.get("user") });
      });

      const session = await authAdapter.createSession("user-1");

      await get(app, "/test", { cookie: `session=${session.id}` });

      expect(capturedUser).not.toBeNull();
      expect(capturedUser.id).toBe("user-1");
    });

    it("should leave the user context unset on unauthenticated requests", async () => {
      let capturedUser: any = "not-called";

      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.route("/api/auth", router);
      app.use("*", middleware);
      app.get("/test", (c) => {
        capturedUser = c.get("user") ?? null;
        return c.json({ hasUser: !!c.get("user") });
      });

      await get(app, "/test");

      expect(capturedUser).toBeNull();
    });
  });
});

describe("PassportAdapter Credential Extraction", () => {
  let adapter: PassportAdapter;
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
    adapter = createPassportAdapter({
      getUserById: async () => null,
      sessionStore,
    });
  });

  describe("Session Cookie Extraction", () => {
    it("should extract credentials from 'session' cookie", async () => {
      const c = await makeContext({ cookie: "session=my-session-id" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("my-session-id");
    });

    it("should extract credentials from 'connect.sid' cookie", async () => {
      const c = await makeContext({ cookie: "connect.sid=passport-session-id" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("passport-session-id");
    });

    it("should prioritize passport 'connect.sid' cookie over plain session cookie", async () => {
      const c = await makeContext({
        cookie: "session=my-session-id; connect.sid=passport-session-id",
      });

      const credentials = adapter.extractCredentials(c);

      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("passport-session-id");
    });
  });

  describe("Bearer Token Extraction", () => {
    it("should extract credentials from Authorization Bearer header", async () => {
      const c = await makeContext({ authorization: "Bearer my-jwt-token" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("bearer");
      expect(credentials?.token).toBe("my-jwt-token");
    });

    it("should not extract bearer when Authorization header has different scheme", async () => {
      const c = await makeContext({ authorization: "Digest something" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).toBeNull();
    });
  });

  describe("Basic Auth Extraction", () => {
    it("should extract credentials from Authorization Basic header", async () => {
      const encoded = Buffer.from("user:pass").toString("base64");
      const c = await makeContext({ authorization: `Basic ${encoded}` });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("basic");
      expect(credentials?.username).toBe("user");
      expect(credentials?.password).toBe("pass");
    });
  });

  describe("API Key Extraction", () => {
    it("should extract credentials from X-API-Key header", async () => {
      const c = await makeContext({ "x-api-key": "my-api-key" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("apiKey");
      expect(credentials?.apiKey).toBe("my-api-key");
    });
  });

  describe("No Credentials", () => {
    it("should return null when no credentials present", async () => {
      const c = await makeContext();

      const credentials = adapter.extractCredentials(c);

      expect(credentials).toBeNull();
    });

    it("should return null for empty cookies and headers", async () => {
      const c = await makeContext({ cookie: "" });

      const credentials = adapter.extractCredentials(c);

      expect(credentials).toBeNull();
    });
  });

  describe("Priority Order", () => {
    it("should prioritize session cookie over bearer token", async () => {
      const c = await makeContext({
        cookie: "session=session-id",
        authorization: "Bearer jwt-token",
      });

      const credentials = adapter.extractCredentials(c);

      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("session-id");
    });

    it("should prioritize bearer token over API key when no session", async () => {
      const c = await makeContext({
        authorization: "Bearer jwt-token",
        "x-api-key": "api-key",
      });

      const credentials = adapter.extractCredentials(c);

      expect(credentials?.type).toBe("bearer");
      expect(credentials?.token).toBe("jwt-token");
    });
  });
});

describe("PassportAdapter Session Validation", () => {
  let adapter: PassportAdapter;
  let sessionStore: InMemorySessionStore;
  let mockUsers: Map<string, any>;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("user-1", { id: "user-1", email: "test@example.com", name: "Test User" });

    adapter = createPassportAdapter({
      getUserById: async (id) => mockUsers.get(id) ?? null,
      sessionStore,
    });
  });

  it("should validate session credentials and return user context", async () => {
    const session = await adapter.createSession("user-1");

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(true);
    expect(result.user).not.toBeNull();
    expect(result.user?.id).toBe("user-1");
    expect(result.expiresAt).toBeDefined();
  });

  it("should reject invalid session ID", async () => {
    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: "non-existent-session",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should reject session for deleted user", async () => {
    const session = await adapter.createSession("user-1");
    mockUsers.delete("user-1");

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("User not found");
  });

  it("should reject invalidated session", async () => {
    const session = await adapter.createSession("user-1");
    await adapter.invalidateSession(session.id);

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(false);
  });
});

describe("End-to-end Auth Flow", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let mockUsers: Map<string, any>;
  let userIdCounter = 100;

  beforeEach(() => {
    app = createTestApp();

    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("existing-user", {
      id: "existing-user",
      email: "existing@example.com",
      name: "Existing User",
      passwordHash: "existing-password",
    });

    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const user = mockUsers.get(id);
        if (!user) return null;
        return { id: user.id, email: user.email, name: user.name, image: null };
      },
      sessionStore,
    });

    const { router, middleware } = useAuth({
      adapter: authAdapter,
      login: {
        validateCredentials: async (email, password) => {
          for (const user of mockUsers.values()) {
            if (user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
          }
          return null;
        },
      },
      signup: {
        createUser: async ({ email, password, name }) => {
          const id = `user-${userIdCounter++}`;
          mockUsers.set(id, { id, email, name: name ?? "New User", passwordHash: password });
          return { id, email, name: name ?? "New User" };
        },
      },
    });

    app.route("/api/auth", router);
    app.use("*", middleware);

    app.get("/protected", (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return c.json({ message: "Protected content", user });
    });
  });

  it("should complete full signup -> access -> logout -> denied flow", async () => {
    const signupRes = await post(app, "/api/auth/signup", {
      email: "e2e@example.com",
      password: "e2epassword",
      name: "E2E User",
    });

    expect(signupRes.status).toBe(200);
    const sessionCookie = setCookies(signupRes.res).find((c) =>
      c.startsWith("session=")
    );
    expect(sessionCookie).toBeDefined();

    const protectedRes = await get(app, "/protected", { cookie: sessionCookie! });

    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.user.email).toBe("e2e@example.com");

    await post(app, "/api/auth/logout", undefined, { cookie: sessionCookie! });

    const deniedRes = await get(app, "/protected", { cookie: sessionCookie! });

    expect(deniedRes.status).toBe(401);
  });

  it("should complete full login -> me -> logout -> me(null) flow", async () => {
    const loginRes = await post(app, "/api/auth/login", {
      email: "existing@example.com",
      password: "existing-password",
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.id).toBe("existing-user");

    const sessionCookie = setCookies(loginRes.res).find((c) =>
      c.startsWith("session=")
    );
    expect(sessionCookie).toBeDefined();

    const meRes = await get(app, "/api/auth/me", { cookie: sessionCookie! });

    expect(meRes.status).toBe(200);
    expect(meRes.body.user).not.toBeNull();
    expect(meRes.body.user.id).toBe("existing-user");

    await post(app, "/api/auth/logout", undefined, { cookie: sessionCookie! });

    const meAfterLogoutRes = await get(app, "/api/auth/me", {
      cookie: sessionCookie!,
    });

    expect(meAfterLogoutRes.status).toBe(200);
    expect(meAfterLogoutRes.body.user).toBeNull();
  });

  it("should handle multiple sessions for same user", async () => {
    const login1 = await post(app, "/api/auth/login", {
      email: "existing@example.com",
      password: "existing-password",
    });

    const login2 = await post(app, "/api/auth/login", {
      email: "existing@example.com",
      password: "existing-password",
    });

    const session1 = setCookies(login1.res).find((c) => c.startsWith("session="));
    const session2 = setCookies(login2.res).find((c) => c.startsWith("session="));
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();

    const me1 = await get(app, "/api/auth/me", { cookie: session1! });
    const me2 = await get(app, "/api/auth/me", { cookie: session2! });

    expect(me1.body.user.id).toBe("existing-user");
    expect(me2.body.user.id).toBe("existing-user");

    await post(app, "/api/auth/logout", undefined, { cookie: session1! });

    const me1AfterLogout = await get(app, "/api/auth/me", { cookie: session1! });
    const me2AfterLogout = await get(app, "/api/auth/me", { cookie: session2! });

    expect(me1AfterLogout.body.user).toBeNull();
    expect(me2AfterLogout.body.user).not.toBeNull();
  });
});
