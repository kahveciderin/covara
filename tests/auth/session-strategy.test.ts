import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import jwt from "jsonwebtoken";
import OAuth2Strategy from "passport-oauth2";
import { useAuth, type AuthUser } from "@/auth/routes";
import { cookieSession, jwtSession, type SessionStrategy } from "@/auth/session";
import { fromPassport } from "@/auth/passport-bridge";
import { InMemorySessionStore } from "@/auth/types";

interface DbUser extends AuthUser {
  passwordHash: string;
}

const users = new Map<string, DbUser>([
  ["u-1", { id: "u-1", email: "a@b.com", name: "Ada", passwordHash: "pw" }],
]);

const getUserById = async (id: string) => users.get(id) ?? null;
const validateCredentials = async (email: string, password: string) => {
  const user = [...users.values()].find((u) => u.email === email);
  return user && user.passwordHash === password
    ? { id: user.id, email: user.email, name: user.name }
    : null;
};

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

const JWT_SECRET = "test-secret-0123456789";

describe("session strategies decouple persistence from credential validation", () => {
  it("cookieSession: password login sets a session cookie and /me reads it", async () => {
    const { router, middleware } = useAuth({
      session: cookieSession({ getUserById, store: new InMemorySessionStore() }),
      login: { validateCredentials },
    });
    const app = new Hono();
    app.route("/api/auth", router);
    app.use("*", middleware);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { user: { id: string }; sessionId?: string };
    expect(body.user.id).toBe("u-1");
    expect(body.sessionId).toBeTruthy();

    const sessionCookie = cookieOf(login, "session");
    expect(sessionCookie).toBeTruthy();

    const me = await app.request("/api/auth/me", { headers: { cookie: sessionCookie } });
    expect(((await me.json()) as { user: { id: string } | null }).user?.id).toBe("u-1");
  });

  it("jwtSession: password login returns a bearer token, /me validates it, /refresh rotates", async () => {
    const refreshStore = new InMemorySessionStore();
    const { router, middleware } = useAuth({
      session: jwtSession({ getUserById, secret: JWT_SECRET, refreshStore }),
      login: { validateCredentials },
    });
    const app = new Hono();
    app.route("/api/auth", router);
    app.use("*", middleware);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { accessToken?: string; tokenType?: string; sessionId?: string };
    expect(body.accessToken).toBeTruthy();
    expect(body.tokenType).toBe("Bearer");
    expect(body.sessionId).toBeUndefined(); // no server-side session for JWT
    expect((jwt.decode(body.accessToken!) as { sub: string }).sub).toBe("u-1");

    const me = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(((await me.json()) as { user: { id: string } | null }).user?.id).toBe("u-1");

    // The refresh cookie was set; /refresh mints a fresh access token.
    const refreshCookie = cookieOf(login, "refreshToken");
    expect(refreshCookie).toBeTruthy();
    const refreshed = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: refreshCookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { accessToken?: string }).accessToken).toBeTruthy();
  });
});

// The headline: a Passport.js provider issuing JWTs — impossible before the
// session/adapter split.
describe("Passport social login + JWT session", () => {
  const AUTHORIZE = "https://idp.test/authorize";
  const TOKEN = "https://idp.test/token";
  const USERINFO = "https://idp.test/userinfo";

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith(TOKEN)) {
        return new Response(JSON.stringify({ access_token: "AT", token_type: "bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.startsWith(USERINFO)) {
        return new Response(
          JSON.stringify({ id: "gh-9", displayName: "Octo", emails: [{ value: "octo@cat.dev" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("nope", { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("logs in via GitHub and yields a JWT (refresh cookie -> /refresh -> bearer)", async () => {
    const store = new Map<string, AuthUser>();
    const refreshStore = new InMemorySessionStore();

    const ghStrategy = new OAuth2Strategy(
      {
        authorizationURL: AUTHORIZE,
        tokenURL: TOKEN,
        clientID: "id",
        clientSecret: "secret",
        callbackURL: "https://app.test/api/auth/social/github/callback",
        state: true,
      },
      (_a: string, _r: string, profile: unknown, done: (e: unknown, u?: unknown) => void) =>
        done(null, profile)
    );
    (ghStrategy as unknown as { userProfile: unknown }).userProfile = function (
      this: { _oauth2: { get(url: string, at: string, cb: (e: unknown, body?: string) => void): void } },
      accessToken: string,
      done: (e: unknown, p?: unknown) => void
    ) {
      this._oauth2.get(USERINFO, accessToken, (err, body) =>
        err ? done(err) : done(null, JSON.parse(body as string))
      );
    };

    const { router, middleware } = useAuth({
      session: jwtSession({
        getUserById: async (id) => store.get(id) ?? null,
        secret: JWT_SECRET,
        refreshStore,
      }),
      social: {
        providers: [fromPassport(ghStrategy, { name: "github" })],
        findOrCreateUser: async ({ profile }) => {
          const user = { id: "gh-9", email: profile.email, name: profile.name };
          store.set(user.id, user);
          return user;
        },
        successRedirect: "/welcome",
      },
    });

    const app = new Hono();
    app.route("/api/auth", router);
    app.use("*", middleware);

    // 1. start GitHub login
    const start = await app.request("/api/auth/social/github");
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = cookieOf(start, "covara_oauth_state");

    // 2. provider callback -> JWT session issued, redirect to successRedirect
    const cb = await app.request(
      `/api/auth/social/github/callback?code=CODE&state=${state}`,
      { headers: { cookie: stateCookie } }
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/welcome");
    const refreshCookie = cookieOf(cb, "refreshToken");
    expect(refreshCookie).toBeTruthy(); // JWT refresh cookie, not a server session

    // 3. exchange the refresh cookie for a bearer access token
    const refreshed = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: refreshCookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(refreshed.status).toBe(200);
    const accessToken = ((await refreshed.json()) as { accessToken?: string }).accessToken!;
    expect(accessToken).toBeTruthy();

    // 4. the bearer token authenticates as the GitHub user
    const me = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const meBody = (await me.json()) as { user: { id: string; email?: string } | null };
    expect(meBody.user?.id).toBe("gh-9");
    expect(meBody.user?.email).toBe("octo@cat.dev");
  });
});

describe("signup fails loudly when session issuance fails", () => {
  const throwingStrategy = (): SessionStrategy => ({
    name: "throwing",
    async authenticate() {
      return { user: null };
    },
    async issue() {
      throw new Error("session backend down");
    },
    async logout() {},
  });

  it("does not return 200 with a user but no auth artifact when issue() throws", async () => {
    const created: Array<{ id: string }> = [];
    const { router } = useAuth({
      session: throwingStrategy(),
      signup: {
        createUser: async ({ email, name }) => {
          const user = { id: "new-1", email, name: name ?? null };
          created.push(user);
          return user;
        },
      },
    });
    const app = new Hono();
    app.route("/api/auth", router);

    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@b.com", password: "pw", name: "New" }),
    });

    expect(created).toHaveLength(1); // user was created
    expect(res.status).not.toBe(200); // but the request must not report success
    const body = (await res.json()) as {
      sessionId?: string;
      accessToken?: string;
    };
    expect(body.sessionId).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
  });
});
