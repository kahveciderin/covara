import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import OAuth2Strategy from "passport-oauth2";
import { createOIDCProvider } from "@/oidc/provider";
import { fromPassport } from "@/auth/passport-bridge";
import { OIDCClient, OIDCProviderConfig, OIDCUser } from "@/oidc/types";

const ISSUER = "https://auth.example.com";
const RP_REDIRECT = "https://rp.example.com/cb";
const UPSTREAM_AUTHORIZE = "https://idp.test/authorize";
const UPSTREAM_TOKEN = "https://idp.test/token";
const UPSTREAM_USERINFO = "https://idp.test/userinfo";

const GH_PROFILE = {
  id: "gh-42",
  displayName: "Octo Cat",
  username: "octocat",
  emails: [{ value: "octo@cat.dev" }],
};

let tokenCalls = 0;
let userinfoCalls = 0;

const installFetchMock = () => {
  tokenCalls = 0;
  userinfoCalls = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith(UPSTREAM_TOKEN)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({ access_token: "AT-1", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.startsWith(UPSTREAM_USERINFO)) {
      userinfoCalls++;
      return new Response(JSON.stringify(GH_PROFILE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
};

const githubStrategy = () => {
  const s = new OAuth2Strategy(
    {
      authorizationURL: UPSTREAM_AUTHORIZE,
      tokenURL: UPSTREAM_TOKEN,
      clientID: "gh-client",
      clientSecret: "gh-secret",
      callbackURL: `${ISSUER}/auth/passport/callback`,
      state: true,
      scope: ["read:user"],
    },
    (_at: string, _rt: string, profile: unknown, done: (e: unknown, u?: unknown) => void) =>
      done(null, profile)
  );
  (s as unknown as { userProfile: unknown }).userProfile = function (
    this: { _oauth2: { get(url: string, at: string, cb: (e: unknown, body?: string) => void): void } },
    accessToken: string,
    done: (e: unknown, p?: unknown) => void
  ) {
    this._oauth2.get(UPSTREAM_USERINFO, accessToken, (err, body) =>
      err ? done(err) : done(null, JSON.parse(body as string))
    );
  };
  return s;
};

const client: OIDCClient = {
  id: "rp",
  name: "Relying Party",
  redirectUris: [RP_REDIRECT],
  grantTypes: ["authorization_code"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  scopes: ["openid", "email", "profile"],
};

const buildProvider = () => {
  const users = new Map<string, OIDCUser>();
  const byAccount = new Map<string, string>();
  const createdFrom: unknown[] = [];

  const config: OIDCProviderConfig = {
    issuer: ISSUER,
    keys: { algorithm: "RS256" },
    clients: [client],
    backends: {
      passport: {
        providers: [fromPassport(githubStrategy(), { name: "github" })],
        findUserByAccount: async (provider, accountId) => {
          const id = byAccount.get(`${provider}:${accountId}`);
          return id ? (users.get(id) ?? null) : null;
        },
        findUserById: async (id) => users.get(id) ?? null,
        createUser: async (account) => {
          createdFrom.push(account);
          const id = `u-${users.size + 1}`;
          byAccount.set(`${account.provider}:${account.providerAccountId}`, id);
          const user: OIDCUser = {
            id,
            email: account.profile.email ?? undefined,
            name: account.profile.name ?? undefined,
          };
          users.set(id, user);
          return user;
        },
      },
    },
  };

  return { provider: createOIDCProvider(config), users, createdFrom };
};

// PKCE pair for the RP's /authorize request.
const verifier = "covara_test_verifier_0123456789_0123456789";
const challenge = crypto
  .createHash("sha256")
  .update(verifier)
  .digest("base64url");

describe("OIDC provider — Passport federated backend", () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.unstubAllGlobals());

  const cookieHeader = (res: Response, name: string): string => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
    return c?.split(";")[0] ?? "";
  };

  it("lists the passport provider as a login button", async () => {
    const { provider } = buildProvider();
    const authz = await provider.router.request(
      `/authorize?response_type=code&client_id=rp&redirect_uri=${encodeURIComponent(RP_REDIRECT)}&scope=openid+email&state=st&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const loginUrl = new URL(authz.headers.get("location")!);
    const interaction = loginUrl.searchParams.get("interaction")!;

    const login = await provider.router.request(`/login?interaction=${interaction}`);
    const html = await login.text();
    expect(login.status).toBe(200);
    expect(html).toContain(`/auth/passport/github?interaction=${interaction}`);
  });

  it("completes a full Passport→OIDC login and issues tokens", async () => {
    const { provider, createdFrom } = buildProvider();
    const app = provider.router;

    // 1. RP starts authorization → redirected to the login page.
    const authz = await app.request(
      `/authorize?response_type=code&client_id=rp&redirect_uri=${encodeURIComponent(RP_REDIRECT)}&scope=openid+email&state=rp-state&code_challenge=${challenge}&code_challenge_method=S256`
    );
    expect(authz.status).toBe(302);
    const interaction = new URL(authz.headers.get("location")!).searchParams.get("interaction")!;

    // 2. User clicks "GitHub" → redirected to the upstream provider.
    const initiate = await app.request(`/auth/passport/github?interaction=${interaction}`);
    expect(initiate.status).toBe(302);
    const upstream = new URL(initiate.headers.get("location")!);
    expect(upstream.origin + upstream.pathname).toBe(UPSTREAM_AUTHORIZE);
    const upstreamState = upstream.searchParams.get("state")!;
    const stateCookie = cookieHeader(initiate, "covara_oidc_passport_state");
    expect(stateCookie).toBeTruthy();

    // 3. Upstream redirects back to the provider's callback → resumes interaction.
    const callback = await app.request(
      `/auth/passport/callback?code=UP_CODE&state=${upstreamState}`,
      { headers: { cookie: stateCookie } }
    );
    expect(callback.status).toBe(302);
    expect(tokenCalls).toBe(1);
    expect(userinfoCalls).toBe(1);
    // Fresh user + no prior consent → goes to consent, with a provider session set.
    const consentUrl = new URL(callback.headers.get("location")!);
    expect(consentUrl.pathname).toBe("/consent");
    const oidcSession = cookieHeader(callback, "oidc_session");
    expect(oidcSession).toContain("oidc_session=");
    expect(createdFrom).toHaveLength(1);

    // 4. User approves consent → redirected back to the RP with an auth code.
    const consentInteraction = consentUrl.searchParams.get("interaction")!;
    const consent = await app.request(`/consent?interaction=${consentInteraction}`, {
      method: "POST",
      headers: {
        cookie: oidcSession,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ action: "allow" }).toString(),
    });
    expect(consent.status).toBe(302);
    const rpRedirect = new URL(consent.headers.get("location")!);
    expect(rpRedirect.origin + rpRedirect.pathname).toBe(RP_REDIRECT);
    expect(rpRedirect.searchParams.get("state")).toBe("rp-state");
    const code = rpRedirect.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 5. RP exchanges the code at /token → real OIDC tokens for the GitHub user.
    const token = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: RP_REDIRECT,
        client_id: "rp",
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { id_token: string; access_token: string };
    expect(tokens.access_token).toBeTruthy();
    const claims = jwt.decode(tokens.id_token) as { sub: string; email?: string };
    expect(claims.sub).toBe("u-1");
    expect(claims.email).toBe("octo@cat.dev");
  });

  it("rejects a callback with no state cookie", async () => {
    const { provider } = buildProvider();
    const res = await provider.router.request(
      `/auth/passport/callback?code=UP_CODE&state=whatever`
    );
    expect(res.status).toBe(400);
    expect(tokenCalls).toBe(0);
  });
});
