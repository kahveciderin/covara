import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createOIDCProvider } from "../../src/oidc/provider";
import {
  OIDCClient,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
  TokenService,
} from "../../src/oidc/types";

const testUser: OIDCUser = {
  id: "user-123",
  email: "test@example.com",
  emailVerified: true,
  name: "Test User",
};

const confidentialClient: OIDCClient = {
  id: "conf-client",
  secret: "super-secret",
  name: "Confidential App",
  redirectUris: ["http://localhost:3000/callback"],
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "client_secret_post",
  scopes: ["openid", "profile", "email", "offline_access"],
};

const createTestConfig = (
  overrides: Partial<OIDCProviderConfig> = {}
): OIDCProviderConfig => ({
  issuer: "https://auth.example.com",
  keys: { algorithm: "RS256" },
  clients: [confidentialClient],
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

const postForm = async (
  app: Hono,
  path: string,
  form: Record<string, string>
) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
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

const setup = () => {
  const app = new Hono();
  const config = createTestConfig();
  const { router, stores, tokenService } = createOIDCProvider(config);
  app.route("/oidc", router);
  return { app, stores, tokenService };
};

const issueRefreshToken = async (
  stores: OIDCProviderStores,
  tokenService: TokenService
) => {
  const tokens = await tokenService.generateTokenSet({
    user: testUser,
    client: confidentialClient,
    scope: "openid profile offline_access",
    includeIdToken: false,
    includeRefreshToken: true,
  });
  if (!tokens.refresh_token) throw new Error("no refresh token");
  return tokens;
};

describe("OIDC Revocation (RFC 7009)", () => {
  let app: Hono;
  let stores: OIDCProviderStores;
  let tokenService: TokenService;

  beforeEach(() => {
    ({ app, stores, tokenService } = setup());
  });

  it("revokes a refresh token so a later refresh-grant fails", async () => {
    const tokens = await issueRefreshToken(stores, tokenService);

    const revoke = await postForm(app, "/oidc/revoke", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });
    expect(revoke.status).toBe(200);

    const refresh = await postForm(app, "/oidc/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });
    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe("invalid_grant");
  });

  it("returns 200 for an unknown token", async () => {
    const res = await postForm(app, "/oidc/revoke", {
      token: "does-not-exist",
      client_id: "conf-client",
      client_secret: "super-secret",
    });
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await postForm(app, "/oidc/revoke", {
      token: "anything",
      client_id: "conf-client",
      client_secret: "wrong-secret",
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_client");
  });

  it("requires a token parameter", async () => {
    const res = await postForm(app, "/oidc/revoke", {
      client_id: "conf-client",
      client_secret: "super-secret",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("OIDC Introspection (RFC 7662)", () => {
  let app: Hono;
  let stores: OIDCProviderStores;
  let tokenService: TokenService;

  beforeEach(() => {
    ({ app, stores, tokenService } = setup());
  });

  it("returns active:true with claims for a valid access token", async () => {
    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: confidentialClient,
      scope: "openid profile",
      includeIdToken: false,
      includeRefreshToken: false,
    });

    const res = await postForm(app, "/oidc/introspect", {
      token: tokens.access_token,
      client_id: "conf-client",
      client_secret: "super-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.sub).toBe("user-123");
    expect(res.body.client_id).toBe("conf-client");
    expect(res.body.scope).toBe("openid profile");
    expect(res.body.token_type).toBe("Bearer");
    expect(typeof res.body.exp).toBe("number");
    expect(typeof res.body.iat).toBe("number");
  });

  it("returns active:true with claims for a valid refresh token", async () => {
    const tokens = await issueRefreshToken(stores, tokenService);

    const res = await postForm(app, "/oidc/introspect", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.sub).toBe("user-123");
    expect(res.body.token_type).toBe("refresh_token");
  });

  it("returns active:false for a revoked refresh token", async () => {
    const tokens = await issueRefreshToken(stores, tokenService);

    await postForm(app, "/oidc/revoke", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });

    const res = await postForm(app, "/oidc/introspect", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("returns active:false for an invalid token", async () => {
    const res = await postForm(app, "/oidc/introspect", {
      token: "not-a-real-token",
      client_id: "conf-client",
      client_secret: "super-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("rejects unauthenticated callers with 401 and does not leak token data", async () => {
    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: confidentialClient,
      scope: "openid profile",
      includeIdToken: false,
      includeRefreshToken: false,
    });

    const res = await postForm(app, "/oidc/introspect", {
      token: tokens.access_token,
      client_id: "conf-client",
      client_secret: "wrong-secret",
    });

    expect(res.status).toBe(401);
    expect(res.body.active).toBeUndefined();
  });

  it("rejects callers with no client credentials at all", async () => {
    const res = await postForm(app, "/oidc/introspect", {
      token: "anything",
    });
    expect(res.status).toBe(401);
  });
});

describe("OIDC client secret hashing", () => {
  it("accepts a scrypt-hashed client secret", async () => {
    const { hashPassword } = await import("../../src/auth/password");
    const hashed = await hashPassword("super-secret");

    const hashedClient: OIDCClient = {
      ...confidentialClient,
      secret: hashed,
    };

    const app = new Hono();
    const { router, tokenService } = createOIDCProvider(
      createTestConfig({ clients: [hashedClient] })
    );
    app.route("/oidc", router);

    const tokens = await tokenService.generateTokenSet({
      user: testUser,
      client: hashedClient,
      scope: "openid offline_access",
      includeIdToken: false,
      includeRefreshToken: true,
    });

    const good = await postForm(app, "/oidc/introspect", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "super-secret",
    });
    expect(good.status).toBe(200);
    expect(good.body.active).toBe(true);

    const bad = await postForm(app, "/oidc/introspect", {
      token: tokens.refresh_token!,
      client_id: "conf-client",
      client_secret: "nope",
    });
    expect(bad.status).toBe(401);
  });
});
