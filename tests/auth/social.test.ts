import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import OAuth2Strategy from "passport-oauth2";
import { useAuth, type AuthUser } from "@/auth/routes";
import { createPassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore } from "@/auth/types";
import { fromPassport, type SocialAccount } from "@/auth/passport-bridge";
import { createKvSocialStateStore } from "@/auth/social";
import { createMemoryKV } from "@/kv/memory";

const AUTHORIZE_URL = "https://idp.test/authorize";
const TOKEN_URL = "https://idp.test/token";
const USERINFO_URL = "https://idp.test/userinfo";

// A passport-shaped profile the provider's userinfo endpoint returns.
const PROFILE = {
  id: "ext-123",
  displayName: "Octo Cat",
  username: "octocat",
  emails: [{ value: "octo@cat.dev" }],
  photos: [{ value: "https://img.test/octo.png" }],
};

let tokenCalls = 0;
let userinfoCalls = 0;

const installFetchMock = () => {
  tokenCalls = 0;
  userinfoCalls = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith(TOKEN_URL)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.startsWith(USERINFO_URL)) {
      userinfoCalls++;
      return new Response(JSON.stringify(PROFILE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
};

const makeStrategy = () => {
  const strategy = new OAuth2Strategy(
    {
      authorizationURL: AUTHORIZE_URL,
      tokenURL: TOKEN_URL,
      clientID: "client-abc",
      clientSecret: "secret-xyz",
      callbackURL: "https://app.test/api/auth/social/github/callback",
      state: true,
      scope: ["read:user"],
    },
    (_at: string, _rt: string, profile: unknown, done: (e: unknown, u?: unknown) => void) =>
      done(null, profile)
  );
  // Fetch the profile over the (patched) transport, like passport-github2 does.
  (strategy as unknown as { userProfile: unknown }).userProfile = function (
    this: { _oauth2: { get(url: string, at: string, cb: (e: unknown, body?: string) => void): void } },
    accessToken: string,
    done: (e: unknown, p?: unknown) => void
  ) {
    this._oauth2.get(USERINFO_URL, accessToken, (err, body) => {
      if (err) return done(err);
      done(null, JSON.parse(body as string));
    });
  };
  return strategy;
};

interface TestHarness {
  app: Hono;
  users: Map<string, AuthUser>;
  accounts: SocialAccount[];
}

const buildApp = (
  socialOverrides: Partial<Parameters<typeof useAuth>[0]["social"]> = {}
): TestHarness => {
  const sessionStore = new InMemorySessionStore();
  const users = new Map<string, AuthUser>();
  const byAccount = new Map<string, string>();
  const accounts: SocialAccount[] = [];

  const adapter = createPassportAdapter({
    getUserById: async (id) => users.get(id) ?? null,
    sessionStore,
  });

  const { router, middleware } = useAuth({
    adapter,
    social: {
      providers: [fromPassport(makeStrategy(), { name: "github" })],
      findOrCreateUser: async (account) => {
        accounts.push(account);
        const key = `${account.provider}:${account.profile.id}`;
        let id = byAccount.get(key);
        if (!id) {
          id = `user-${users.size + 1}`;
          byAccount.set(key, id);
          users.set(id, {
            id,
            email: account.profile.email,
            name: account.profile.name,
            image: account.profile.image,
          });
        }
        return users.get(id)!;
      },
      ...socialOverrides,
    },
  });

  const app = new Hono();
  app.route("/api/auth", router);
  app.use("*", middleware);
  return { app, users, accounts };
};

// Drive the authorize leg and return the state param + state cookie.
const startLogin = async (app: Hono) => {
  const res = await app.request("/api/auth/social/github");
  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state");
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("covara_oauth_state="));
  const stateCookie = setCookie?.split(";")[0] ?? "";
  return { res, location, state, stateCookie };
};

describe("social login (Passport bridge)", () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.unstubAllGlobals());

  it("redirects to the provider with state, scope and a state cookie", async () => {
    const { app } = buildApp();
    const { res, location, state, stateCookie } = await startLogin(app);

    expect(res.status).toBe(302);
    expect(location.startsWith(AUTHORIZE_URL)).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("client-abc");
    expect(params.get("scope")).toBe("read:user");
    expect(params.get("redirect_uri")).toBe(
      "https://app.test/api/auth/social/github/callback"
    );
    expect(state).toBeTruthy();
    expect(stateCookie).toContain("covara_oauth_state=");
  });

  it("completes the full flow: token exchange, profile fetch, session", async () => {
    const { app, accounts } = buildApp();
    const { state, stateCookie } = await startLogin(app);

    const cb = await app.request(
      `/api/auth/social/github/callback?code=AUTH_CODE&state=${state}`,
      { headers: { cookie: stateCookie } }
    );

    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
    expect(tokenCalls).toBe(1);
    expect(userinfoCalls).toBe(1);

    // The session cookie was set and resolves to the social user.
    const sessionCookie = cb.headers
      .getSetCookie()
      .find((c) => c.startsWith("session="))!
      .split(";")[0];
    expect(sessionCookie).toContain("session=");

    const me = await app.request("/api/auth/me", { headers: { cookie: sessionCookie } });
    const meBody = (await me.json()) as { user: { email: string; name: string } | null };
    expect(meBody.user?.email).toBe("octo@cat.dev");
    expect(meBody.user?.name).toBe("Octo Cat");

    // findOrCreateUser received the normalized profile.
    expect(accounts).toHaveLength(1);
    expect(accounts[0].provider).toBe("github");
    expect(accounts[0].providerAccountId).toBe("ext-123");
    expect(accounts[0].profile.id).toBe("ext-123");
    expect(accounts[0].profile.email).toBe("octo@cat.dev");
    expect(accounts[0].profile.username).toBe("octocat");
  });

  it("rejects a callback with no state cookie", async () => {
    const { app } = buildApp();
    const { state } = await startLogin(app);
    const cb = await app.request(
      `/api/auth/social/github/callback?code=AUTH_CODE&state=${state}`
    );
    expect(cb.status).toBe(401);
    const body = (await cb.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SOCIAL_AUTH_FAILED");
    expect(tokenCalls).toBe(0);
  });

  it("rejects a forged state param (CSRF) without exchanging the code", async () => {
    const { app } = buildApp();
    const { stateCookie } = await startLogin(app);
    const cb = await app.request(
      `/api/auth/social/github/callback?code=AUTH_CODE&state=tampered`,
      { headers: { cookie: stateCookie } }
    );
    expect(cb.status).toBe(401);
    expect(tokenCalls).toBe(0);
  });

  it("returns 404 for an unknown provider", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/auth/social/nope");
    expect(res.status).toBe(404);
  });

  it("treats a provider error response as a failure", async () => {
    const { app } = buildApp();
    const { stateCookie } = await startLogin(app);
    const cb = await app.request(
      `/api/auth/social/github/callback?error=access_denied&error_description=nope`,
      { headers: { cookie: stateCookie } }
    );
    expect(cb.status).toBe(401);
    expect(tokenCalls).toBe(0);
  });

  it("redirects to failureRedirect when configured", async () => {
    const { app } = buildApp({ failureRedirect: "/login?error=social" });
    const cb = await app.request(
      `/api/auth/social/github/callback?code=AUTH_CODE&state=x`
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/login?error=social");
  });

  it("reuses the strategy across logins (transport patched once, no leak)", async () => {
    const { app, users } = buildApp();

    for (let i = 0; i < 2; i++) {
      const { state, stateCookie } = await startLogin(app);
      const cb = await app.request(
        `/api/auth/social/github/callback?code=AUTH_CODE&state=${state}`,
        { headers: { cookie: stateCookie } }
      );
      expect(cb.status).toBe(302);
    }
    // Same provider account → one user, logged in twice.
    expect(users.size).toBe(1);
  });

  it("works with a KV-backed state store (multi-instance / Workers)", async () => {
    const kv = createMemoryKV();
    const { app } = buildApp({ stateStore: createKvSocialStateStore(kv) });
    const { state, stateCookie } = await startLogin(app);
    const cb = await app.request(
      `/api/auth/social/github/callback?code=AUTH_CODE&state=${state}`,
      { headers: { cookie: stateCookie } }
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
  });
});
