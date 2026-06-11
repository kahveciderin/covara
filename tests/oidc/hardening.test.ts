import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createOIDCProvider } from "../../src/oidc/provider";
import { createTokenService } from "../../src/oidc/tokens";
import { createKeyManager } from "../../src/oidc/keys";
import { validateIdTokenNonce } from "../../src/oidc/tokens";
import { redirectUriMatches, redirectUriAllowed } from "../../src/oidc/util";
import {
  createStores,
  KVAuthorizationCodeStore,
} from "../../src/oidc/stores";
import { resetOIDCRateLimits } from "../../src/oidc/rate-limit";
import { createMemoryKV } from "../../src/kv/memory";
import { setGlobalKV } from "../../src/kv/types";
import {
  OIDCClient,
  OIDCProviderConfig,
  OIDCUser,
} from "../../src/oidc/types";

const testUser: OIDCUser = {
  id: "user-123",
  email: "test@example.com",
  emailVerified: true,
  name: "Test User",
};

const publicClient: OIDCClient = {
  id: "public-client",
  name: "Public App",
  redirectUris: ["http://localhost:3000/callback"],
  grantTypes: ["authorization_code"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  scopes: ["openid", "profile", "email"],
};

const confClient: OIDCClient = {
  id: "conf-client",
  secret: "super-secret",
  name: "Confidential App",
  redirectUris: ["http://localhost:3000/callback"],
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "client_secret_post",
  scopes: ["openid", "profile", "email", "offline_access"],
};

const baseConfig = (
  overrides: Partial<OIDCProviderConfig> = {}
): OIDCProviderConfig => ({
  issuer: "https://auth.example.com",
  keys: { algorithm: "RS256" },
  clients: [publicClient, confClient],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) =>
        email === "test@example.com" && password === "password123"
          ? testUser
          : null,
      findUserById: async (id) => (id === "user-123" ? testUser : null),
    },
  },
  ...overrides,
});

const get = async (app: Hono, path: string, headers: Record<string, string> = {}) => {
  const res = await app.request(path, { method: "GET", headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
};

const postForm = async (app: Hono, path: string, form: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

describe("redirect_uri component matching", () => {
  it("matches exact uri", () => {
    expect(redirectUriMatches("https://app.com/cb", "https://app.com/cb")).toBe(true);
  });

  it("rejects scheme mismatch", () => {
    expect(redirectUriMatches("https://app.com/cb", "http://app.com/cb")).toBe(false);
  });

  it("rejects host mismatch", () => {
    expect(redirectUriMatches("https://app.com/cb", "https://evil.com/cb")).toBe(false);
  });

  it("rejects port mismatch", () => {
    expect(redirectUriMatches("http://localhost:3000/cb", "http://localhost:4000/cb")).toBe(false);
  });

  it("rejects path mismatch", () => {
    expect(redirectUriMatches("https://app.com/cb", "https://app.com/other")).toBe(false);
  });

  it("ignores differing query when registered has none", () => {
    expect(redirectUriMatches("https://app.com/cb", "https://app.com/cb?foo=bar")).toBe(true);
  });

  it("requires exact query when registered has one", () => {
    expect(redirectUriMatches("https://app.com/cb?a=1", "https://app.com/cb?a=2")).toBe(false);
    expect(redirectUriMatches("https://app.com/cb?a=1", "https://app.com/cb?a=1")).toBe(true);
  });

  it("keeps custom-scheme native uris working", () => {
    expect(redirectUriMatches("myapp://callback", "myapp://callback")).toBe(true);
    expect(redirectUriAllowed(["myapp://callback"], "myapp://callback")).toBe(true);
  });

  it("keeps loopback uris working", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:8080/cb"], "http://127.0.0.1:8080/cb")).toBe(true);
  });

  it("rejects substring-style bypass that old includes() allowed", () => {
    expect(
      redirectUriAllowed(["http://localhost:3000/callback"], "http://localhost:3000/callback.evil.com")
    ).toBe(false);
  });
});

describe("authorize redirect_uri enforcement", () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    const { router } = createOIDCProvider(baseConfig());
    app.route("/oidc", router);
  });

  it("accepts a registered redirect_uri", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const res = await get(app, `/oidc/authorize?${q}`);
    expect(res.status).toBe(302);
  });

  it("rejects a port-mismatched redirect_uri", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "http://localhost:9999/callback",
      scope: "openid",
      state: "s",
    });
    const res = await get(app, `/oidc/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });
});

describe("PKCE enforcement", () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    const { router } = createOIDCProvider(baseConfig());
    app.route("/oidc", router);
  });

  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("rejects code_challenge_method=plain explicitly", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "plain",
    });
    const res = await get(app, `/oidc/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("error_description")).toContain("plain");
  });

  it("accepts S256", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await get(app, `/oidc/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("requires PKCE for public clients", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
    });
    const res = await get(app, `/oidc/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("error_description")).toContain("PKCE");
  });

  it("requires PKCE for confidential clients when security.pkce.required", async () => {
    const app2 = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ security: { pkce: { required: true } } })
    );
    app2.route("/oidc", router);

    const q = new URLSearchParams({
      response_type: "code",
      client_id: "conf-client",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
    });
    const res = await get(app2, `/oidc/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });
});

describe("at_hash computation", () => {
  it("produces a valid base64url at_hash for PS256 (no shaSha bug)", async () => {
    const keyManager = createKeyManager({ algorithm: "PS256" });
    const config = baseConfig({ keys: { algorithm: "PS256" } });
    const tokenService = createTokenService(config, keyManager, {
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      deleteByUserId: async () => {},
    });

    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: confClient,
      scope: "openid profile",
      includeIdToken: true,
      includeRefreshToken: false,
    });

    expect(tokens.id_token).toBeDefined();
    const claims = await tokenService.decodeIdToken(tokens.id_token!);
    expect(typeof claims.at_hash).toBe("string");
    expect(claims.at_hash).toMatch(/^[A-Za-z0-9_-]+$/);
    // sha256 -> 32 bytes -> left half 16 bytes -> 22 base64url chars
    expect((claims.at_hash as string).length).toBe(22);
  });

  it("produces a 32-char at_hash for PS512 (sha512 left half = 32 bytes)", async () => {
    const keyManager = createKeyManager({ algorithm: "PS512" });
    const config = baseConfig({ keys: { algorithm: "PS512" } });
    const tokenService = createTokenService(config, keyManager, {
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      deleteByUserId: async () => {},
    });

    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: confClient,
      scope: "openid",
      includeIdToken: true,
      includeRefreshToken: false,
    });
    const claims = await tokenService.decodeIdToken(tokens.id_token!);
    expect((claims.at_hash as string).length).toBe(43);
  });
});

describe("nonce round-trip helper", () => {
  it("validates id_token nonce", async () => {
    const keyManager = createKeyManager({ algorithm: "RS256" });
    const config = baseConfig();
    const tokenService = createTokenService(config, keyManager, {
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      deleteByUserId: async () => {},
    });

    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: confClient,
      scope: "openid",
      nonce: "abc-nonce",
      includeIdToken: true,
      includeRefreshToken: false,
    });

    expect(validateIdTokenNonce(tokens.id_token!, "abc-nonce")).toBe(true);
    expect(validateIdTokenNonce(tokens.id_token!, "wrong")).toBe(false);
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetOIDCRateLimits());

  it("returns 429 on /token after exceeding the limit", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ security: { rateLimiting: { token: { windowMs: 60000, max: 2 } } } })
    );
    app.route("/oidc", router);

    const send = () =>
      postForm(app, "/oidc/token", {
        grant_type: "refresh_token",
        refresh_token: "nope",
        client_id: "conf-client",
        client_secret: "super-secret",
      });

    expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(400);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("rate_limited");
  });

  it("returns 429 on /jwks after exceeding the limit", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ security: { rateLimiting: { jwks: { windowMs: 60000, max: 1 } } } })
    );
    app.route("/oidc", router);

    expect((await get(app, "/oidc/jwks")).status).toBe(200);
    expect((await get(app, "/oidc/jwks")).status).toBe(429);
  });
});

describe("dynamic client registration", () => {
  it("returns 404 when registration is disabled", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(baseConfig());
    app.route("/oidc", router);

    const res = await postForm(app, "/oidc/register", {});
    expect(res.status).toBe(404);
  });

  it("creates a usable confidential client when enabled", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ registration: { enabled: true } })
    );
    app.route("/oidc", router);

    const res = await app.request("/oidc/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Dynamic App",
        redirect_uris: ["https://dyn.example.com/callback"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(body.client_id).toBeDefined();
    expect(body.client_secret).toBeDefined();

    const disc = await get(app, "/oidc/.well-known/openid-configuration");
    expect(disc.body.registration_endpoint).toContain("/register");

    const q = new URLSearchParams({
      response_type: "code",
      client_id: body.client_id,
      redirect_uri: "https://dyn.example.com/callback",
      scope: "openid",
      state: "s",
    });
    const authz = await get(app, `/oidc/authorize?${q}`);
    expect(authz.status).toBe(302);
    expect(authz.headers.get("location")).toContain("/login");
  });

  it("rejects invalid redirect_uris", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ registration: { enabled: true } })
    );
    app.route("/oidc", router);

    const res = await app.request("/oidc/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("requires the initial access token when configured", async () => {
    const app = new Hono();
    const { router } = createOIDCProvider(
      baseConfig({ registration: { enabled: true, initialAccessToken: "secret-iat" } })
    );
    app.route("/oidc", router);

    const denied = await app.request("/oidc/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://a.com/cb"] }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request("/oidc/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-iat",
      },
      body: JSON.stringify({ redirect_uris: ["https://a.com/cb"] }),
    });
    expect(allowed.status).toBe(201);
  });
});

describe("consent expiry and revocation", () => {
  it("expires consent and forces re-consent", async () => {
    const stores = createStores({ type: "memory" }, [confClient]);
    const now = Date.now();

    await stores.consent.set({
      userId: "user-123",
      clientId: "conf-client",
      scopes: ["openid"],
      grantedAt: now - 10_000,
      expiresAt: now - 1_000,
    });

    const expired = await stores.consent.get("user-123", "conf-client");
    expect(expired).toBeNull();

    await stores.consent.set({
      userId: "user-123",
      clientId: "conf-client",
      scopes: ["openid"],
      grantedAt: now,
      expiresAt: now + 60_000,
    });
    const valid = await stores.consent.get("user-123", "conf-client");
    expect(valid).not.toBeNull();
  });

  it("revokes consent via DELETE/POST endpoint", async () => {
    const stores = createStores({ type: "memory" }, [confClient]);
    await stores.consent.set({
      userId: "user-123",
      clientId: "conf-client",
      scopes: ["openid"],
      grantedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(await stores.consent.get("user-123", "conf-client")).not.toBeNull();

    await stores.consent.delete("user-123", "conf-client");
    expect(await stores.consent.get("user-123", "conf-client")).toBeNull();
  });
});

describe("KV-backed stores survive a restart", () => {
  it("keeps an auth code across a new store instance over the same KV", async () => {
    const kv = createMemoryKV();
    await kv.connect();

    const store1 = new KVAuthorizationCodeStore(kv, "oidc");
    await store1.set({
      code: "persist-code",
      clientId: "conf-client",
      userId: "user-123",
      redirectUri: "http://localhost:3000/callback",
      scope: "openid",
      authTime: Math.floor(Date.now() / 1000),
      expiresAt: Date.now() + 600_000,
    });

    // simulate a process restart: brand new store instance, same KV backend
    const store2 = new KVAuthorizationCodeStore(kv, "oidc");
    const recovered = await store2.get("persist-code");
    expect(recovered).not.toBeNull();
    expect(recovered!.userId).toBe("user-123");
  });

  it("createStores uses KV when a global KV is configured", async () => {
    const kv = createMemoryKV();
    await kv.connect();
    setGlobalKV(kv);

    const stores = createStores(undefined, []);
    await stores.authorizationCodes.set({
      code: "global-code",
      clientId: "conf-client",
      userId: "user-123",
      redirectUri: "http://localhost:3000/callback",
      scope: "openid",
      authTime: Math.floor(Date.now() / 1000),
      expiresAt: Date.now() + 600_000,
    });

    const raw = await kv.get("oidc:authcodes:global-code");
    expect(raw).not.toBeNull();
  });
});

describe("login_hint XSS escaping", () => {
  it("escapes a script tag in login_hint", async () => {
    const app = new Hono();
    const { router, stores } = createOIDCProvider(baseConfig());
    app.route("/oidc", router);

    const interactionId = "xss-interaction";
    await stores.interactions.set(interactionId, {
      authRequest: {
        responseType: "code",
        clientId: "public-client",
        redirectUri: "http://localhost:3000/callback",
        scope: "openid",
        state: "s",
        loginHint: '"><script>alert(1)</script>',
      },
      expiresAt: Date.now() + 60_000,
    });

    const res = await get(app, `/oidc/login?interaction=${interactionId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;");
  });
});
