import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// A browser document (cookies, DOM for rendering) on top of Node's own fetch
// primitives: happy-dom's Response hides Set-Cookie like a browser does, which
// would make a real in-process server unusable as the cookie-issuing backend.
await vi.hoisted(async () => {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "http://localhost:3000" });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const globals: Record<string, unknown> = {
    window: win,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Node: w.Node,
    Element: w.Element,
    Text: w.Text,
    MutationObserver: w.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  // Unmount and let React's scheduler drain before removing the DOM globals;
  // work it already queued (setImmediate) still reads `window`.
  cleanup();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  for (const key of ["window", "document", "HTMLElement", "Node", "Element", "Text", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

import { createElement } from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { Hono } from "hono";
import { useAuth as useAuthServer, type AuthUser } from "@/auth/routes";
import { cookieSession } from "@/auth/session";
import { InMemorySessionStore } from "@/auth/types";
import { errorHandler } from "@/middleware/error";
import { useAuth, type UseAuthResult } from "@/client/react";
import { createClient } from "@/client";
import { TransportError } from "@/client/transport";
import { createCookieFetch } from "../helpers/cookie-fetch";

const BASE = "http://localhost:3000";

const users = new Map<string, AuthUser & { password: string }>([
  ["u-1", { id: "u-1", email: "a@b.com", name: "Ada", password: "pw" }],
]);

const buildServer = (csrf: Parameters<typeof useAuthServer>[0]["csrf"] = true) => {
  const { router, middleware } = useAuthServer({
    session: cookieSession({
      getUserById: async (id) => users.get(id) ?? null,
      store: new InMemorySessionStore(),
    }),
    login: {
      validateCredentials: async (email, password) => {
        const user = [...users.values()].find((u) => u.email === email);
        return user && user.password === password
          ? { id: user.id, email: user.email, name: user.name }
          : null;
      },
    },
    csrf,
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/auth", router);
  app.use("*", middleware);
  return app;
};

const renderAuth = (options: Parameters<typeof useAuth>[0] = {}) => {
  const result: { current: UseAuthResult<{ id: string }> | null } = { current: null };
  const Probe = () => {
    result.current = useAuth<{ id: string }>({ baseUrl: BASE, ...options });
    return null;
  };
  render(createElement(Probe));
  return result;
};

const sessionUser = async (app: Hono, jar: Map<string, { value: string }>) => {
  const cookie = [...jar.entries()].map(([n, { value }]) => `${n}=${value}`).join("; ");
  const res = await app.request("/api/auth/me", { headers: { cookie } });
  return ((await res.json()) as { user: { id: string } | null }).user;
};

let storeKey = 0;

describe("useAuth() against a CSRF-protected /api/auth", () => {
  let app: Hono;
  let browser: ReturnType<typeof createCookieFetch>;

  beforeEach(() => {
    app = buildServer();
    browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);
  });

  afterEach(() => {
    cleanup();
    browser.reset();
    vi.unstubAllGlobals();
  });

  // Each test gets its own shared auth store (keyed by checkUrl).
  const fresh = () => ({ checkUrl: `/api/auth/me?t=${++storeKey}` });

  it("logs in with the CSRF header echoed from the cookie", async () => {
    const auth = renderAuth(fresh());
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));

    await act(() => auth.current!.login("a@b.com", "pw"));

    const login = browser.requests.find((r) => r.path === "/api/auth/login")!;
    expect(login.status).toBe(200);
    expect(login.headers.get("x-csrf-token")).toBeTruthy();
    await waitFor(() => expect(auth.current!.user?.id).toBe("u-1"));
  });

  it("obtains a CSRF cookie first when login is called before any safe request", async () => {
    const auth = renderAuth(fresh());
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));
    browser.reset();

    await act(() => auth.current!.login("a@b.com", "pw"));

    const login = browser.requests.find((r) => r.path === "/api/auth/login")!;
    expect(login.status).toBe(200);
    await waitFor(() => expect(auth.current!.user?.id).toBe("u-1"));
  });

  it("logs out on the server, not just locally", async () => {
    const auth = renderAuth(fresh());
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));
    await act(() => auth.current!.login("a@b.com", "pw"));
    await waitFor(() => expect(auth.current!.user?.id).toBe("u-1"));
    const jarBefore = new Map(browser.jar);

    await act(() => auth.current!.logout());

    const logout = browser.requests.find((r) => r.path === "/api/auth/logout")!;
    expect(logout.status).toBe(200);
    expect(auth.current!.status).toBe("unauthenticated");
    // The old session cookie no longer authenticates.
    expect(await sessionUser(app, jarBefore)).toBeNull();
  });

  it("surfaces the server's problem detail for a failed login", async () => {
    const auth = renderAuth(fresh());
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));

    await expect(auth.current!.login("a@b.com", "wrong")).rejects.toThrow(
      "Invalid email or password"
    );
  });

  it("uses a renamed cookie/header pair when configured to match the server", async () => {
    app = buildServer({ cookieName: "xsrf", headerName: "X-XSRF" });
    browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);

    const auth = renderAuth({ ...fresh(), csrf: { cookieName: "xsrf", headerName: "X-XSRF" } });
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));
    await act(() => auth.current!.login("a@b.com", "pw"));

    expect(browser.requests.find((r) => r.path === "/api/auth/login")!.status).toBe(200);
  });

  it("sends no CSRF header when disabled", async () => {
    const auth = renderAuth({ ...fresh(), csrf: false });
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));

    await expect(auth.current!.login("a@b.com", "pw")).rejects.toThrow(
      "CSRF token validation failed"
    );
  });
});

describe("useAuth() error messages from non-Covara error bodies", () => {
  const respond = (body: BodyInit | null, init: ResponseInit) => {
    const app = new Hono();
    app.get("/api/auth/me", (c) => c.json({ user: null }));
    app.post("/api/auth/verify/request", () => new Response(body, init));
    const browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads a plain { error: string } body", async () => {
    respond(JSON.stringify({ error: "Email service is down" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    const auth = renderAuth({ checkUrl: `/api/auth/me?t=${++storeKey}` });
    await expect(auth.current!.requestEmailVerification("a@b.com")).rejects.toThrow(
      "Email service is down"
    );
  });

  it("reads a plain-text body", async () => {
    respond("Bad gateway upstream", { status: 502 });
    const auth = renderAuth({ checkUrl: `/api/auth/me?t=${++storeKey}` });
    await expect(auth.current!.requestEmailVerification("a@b.com")).rejects.toThrow(
      "Bad gateway upstream"
    );
  });

  it("falls back to the status for an empty body", async () => {
    respond(null, { status: 500 });
    const auth = renderAuth({ checkUrl: `/api/auth/me?t=${++storeKey}` });
    await expect(auth.current!.requestEmailVerification("a@b.com")).rejects.toThrow(
      "Request failed (500)"
    );
  });
});

describe("client.session against a CSRF-protected /api/auth", () => {
  let app: Hono;
  let browser: ReturnType<typeof createCookieFetch>;

  beforeEach(() => {
    app = buildServer();
    browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);
  });

  afterEach(() => {
    browser.reset();
    vi.unstubAllGlobals();
  });

  it("logs in and out with the CSRF header, priming the cookie when missing", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });

    const login = await client.session.login("a@b.com", "pw");
    expect((login.user as { id: string }).id).toBe("u-1");
    expect(await client.session.me<{ id: string }>()).toMatchObject({ id: "u-1" });

    const jarBefore = new Map(browser.jar);
    await client.session.logout();
    expect(await sessionUser(app, jarBefore)).toBeNull();
  });

  it("throws a TransportError carrying the problem detail and code", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    const error = await client.session.login("a@b.com", "wrong").catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid email or password");
    expect(error.code).toBe("UNAUTHORIZED");
  });
});
