import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createOIDCProvider } from "../../src/oidc/provider";
import { createKeyManager } from "../../src/oidc/keys";
import { generateDiscoveryDocument } from "../../src/oidc/discovery";
import { OIDCClient, OIDCProviderConfig, OIDCUser } from "../../src/oidc/types";
import { get, post } from "../helpers/hono";

const testUser: OIDCUser = {
  id: "user-123",
  email: "test@example.com",
  emailVerified: true,
  name: "Test User",
  givenName: "Test",
  familyName: "User",
  picture: "https://example.com/avatar.jpg",
};

const testClient: OIDCClient = {
  id: "test-client",
  secret: "test-secret",
  name: "Test Application",
  redirectUris: ["http://localhost:3000/callback"],
  postLogoutRedirectUris: ["http://localhost:3000"],
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  scopes: ["openid", "profile", "email", "offline_access"],
};

const createTestConfig = (
  overrides: Partial<OIDCProviderConfig> = {}
): OIDCProviderConfig => ({
  issuer: "https://auth.example.com",
  keys: {
    algorithm: "RS256",
  },
  clients: [testClient],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email: string, password: string) => {
        if (email === "test@example.com" && password === "password123") {
          return testUser;
        }
        return null;
      },
      findUserById: async (id: string) => {
        if (id === "user-123") return testUser;
        return null;
      },
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
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

describe("OIDC Provider", () => {
  describe("Discovery Document", () => {
    it("should generate valid discovery document", () => {
      const config = createTestConfig();
      const discovery = generateDiscoveryDocument(config);

      expect(discovery.issuer).toBe("https://auth.example.com");
      expect(discovery.authorization_endpoint).toBe(
        "https://auth.example.com/authorize"
      );
      expect(discovery.token_endpoint).toBe("https://auth.example.com/token");
      expect(discovery.userinfo_endpoint).toBe(
        "https://auth.example.com/userinfo"
      );
      expect(discovery.jwks_uri).toBe("https://auth.example.com/jwks");
      expect(discovery.end_session_endpoint).toBe(
        "https://auth.example.com/logout"
      );
    });

    it("should include supported response types", () => {
      const config = createTestConfig();
      const discovery = generateDiscoveryDocument(config);

      expect(discovery.response_types_supported).toContain("code");
    });

    it("should include supported grant types", () => {
      const config = createTestConfig();
      const discovery = generateDiscoveryDocument(config);

      expect(discovery.grant_types_supported).toContain("authorization_code");
      expect(discovery.grant_types_supported).toContain("refresh_token");
    });

    it("should include PKCE methods", () => {
      const config = createTestConfig();
      const discovery = generateDiscoveryDocument(config);

      expect(discovery.code_challenge_methods_supported).toContain("S256");
    });
  });

  describe("Key Manager", () => {
    it("should generate RSA key pair", async () => {
      const keyManager = createKeyManager({ algorithm: "RS256" });
      const keyPair = await keyManager.getCurrentKey();

      expect(keyPair.alg).toBe("RS256");
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.kid).toBeDefined();
    });

    it("should sign and verify tokens", async () => {
      const keyManager = createKeyManager({ algorithm: "RS256" });

      const payload = {
        sub: "user-123",
        iss: "https://auth.example.com",
        aud: "test-client",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      const token = await keyManager.signToken(payload);
      expect(token).toBeDefined();
      expect(token.split(".")).toHaveLength(3);

      const verified = await keyManager.verifyToken(token);
      expect(verified.sub).toBe("user-123");
      expect(verified.iss).toBe("https://auth.example.com");
    });

    it("should expose public keys as JWK", async () => {
      const keyManager = createKeyManager({ algorithm: "RS256" });
      const jwks = await keyManager.getPublicKeys();

      expect(jwks).toHaveLength(1);
      expect(jwks[0]!.kty).toBe("RSA");
      expect(jwks[0]!.use).toBe("sig");
      expect(jwks[0]!.alg).toBe("RS256");
      expect(jwks[0]!.n).toBeDefined();
      expect(jwks[0]!.e).toBeDefined();
    });
  });

  describe("Provider Router", () => {
    let app: Hono;

    beforeEach(() => {
      app = new Hono();

      const config = createTestConfig();
      const { router } = createOIDCProvider(config);
      app.route("/oidc", router);
    });

    it("should serve discovery document", async () => {
      const res = await get(app, "/oidc/.well-known/openid-configuration");

      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe("https://auth.example.com");
    });

    it("should serve JWKS endpoint", async () => {
      const res = await get(app, "/oidc/jwks");

      expect(res.status).toBe(200);
      expect(res.body.keys).toBeDefined();
      expect(Array.isArray(res.body.keys)).toBe(true);
    });

    describe("Authorization Endpoint", () => {
      it("should redirect to login for valid request", async () => {
        const query = new URLSearchParams({
          response_type: "code",
          client_id: "test-client",
          redirect_uri: "http://localhost:3000/callback",
          scope: "openid profile email",
          state: "test-state",
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
        });
        const res = await get(app, `/oidc/authorize?${query.toString()}`);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("/login");
      });

      it("should reject invalid client_id", async () => {
        const query = new URLSearchParams({
          response_type: "code",
          client_id: "invalid-client",
          redirect_uri: "http://localhost:3000/callback",
          scope: "openid",
          state: "test-state",
        });
        const res = await get(app, `/oidc/authorize?${query.toString()}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_client");
      });

      it("should reject invalid redirect_uri", async () => {
        const query = new URLSearchParams({
          response_type: "code",
          client_id: "test-client",
          redirect_uri: "http://malicious.com/callback",
          scope: "openid",
          state: "test-state",
        });
        const res = await get(app, `/oidc/authorize?${query.toString()}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_redirect_uri");
      });

      it("should require state parameter", async () => {
        const query = new URLSearchParams({
          response_type: "code",
          client_id: "test-client",
          redirect_uri: "http://localhost:3000/callback",
          scope: "openid",
        });
        const res = await get(app, `/oidc/authorize?${query.toString()}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_request");
      });
    });

    describe("Token Endpoint", () => {
      it("should reject missing grant_type", async () => {
        const res = await postForm(app, "/oidc/token", {
          code: "test-code",
          redirect_uri: "http://localhost:3000/callback",
          client_id: "test-client",
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("unsupported_grant_type");
      });

      it("should reject invalid authorization code", async () => {
        const res = await postForm(app, "/oidc/token", {
          grant_type: "authorization_code",
          code: "invalid-code",
          redirect_uri: "http://localhost:3000/callback",
          client_id: "test-client",
          code_verifier: "test-verifier",
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_grant");
      });

      it("should reject invalid refresh token", async () => {
        const res = await postForm(app, "/oidc/token", {
          grant_type: "refresh_token",
          refresh_token: "invalid-refresh-token",
          client_id: "test-client",
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_grant");
      });
    });

    describe("UserInfo Endpoint", () => {
      it("should reject request without authorization", async () => {
        const res = await get(app, "/oidc/userinfo");

        expect(res.status).toBe(401);
      });

      it("should reject invalid access token", async () => {
        const res = await get(app, "/oidc/userinfo", {
          Authorization: "Bearer invalid-token",
        });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe("invalid_token");
      });
    });

    describe("Logout Endpoint", () => {
      it("should handle logout without id_token_hint", async () => {
        const res = await get(app, "/oidc/logout");

        expect(res.status).toBe(200);
      });

      it("should handle post_logout_redirect_uri", async () => {
        const query = new URLSearchParams({
          post_logout_redirect_uri: "http://localhost:3000",
          client_id: "test-client",
        });
        const res = await get(app, `/oidc/logout?${query.toString()}`);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("http://localhost:3000");
      });
    });
  });

  describe("Provider Middleware", () => {
    it("should validate access token", async () => {
      const config = createTestConfig();
      const { middleware, tokenService } = createOIDCProvider(config);

      const tokenSet = await tokenService.generateTokenSet({
        user: testUser,
        client: testClient,
        scope: "openid profile email",
        authTime: Math.floor(Date.now() / 1000),
      });

      const app = new Hono();
      app.use("*", middleware);
      app.get("/protected", (c) => {
        return c.json({ user: c.get("user") });
      });

      const res = await get(app, "/protected", {
        Authorization: `Bearer ${tokenSet.access_token}`,
      });

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("user-123");
    });

    it("should pass through without authorization header", async () => {
      const config = createTestConfig();
      const { middleware } = createOIDCProvider(config);

      const app = new Hono();
      app.use("*", middleware);
      app.get("/public", (c) => {
        return c.json({ ok: true });
      });

      const res = await get(app, "/public");

      expect(res.status).toBe(200);
    });

    it("should reject invalid token", async () => {
      const config = createTestConfig();
      const { middleware } = createOIDCProvider(config);

      const app = new Hono();
      app.use("*", middleware);
      app.get("/protected", (c) => {
        return c.json({ ok: true });
      });

      const res = await get(app, "/protected", {
        Authorization: "Bearer invalid-token",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("Stores", () => {
    it("should store and retrieve authorization codes", async () => {
      const config = createTestConfig();
      const { stores } = createOIDCProvider(config);

      await stores.authorizationCodes.set({
        code: "test-code",
        clientId: "test-client",
        userId: "user-123",
        redirectUri: "http://localhost:3000/callback",
        scope: "openid profile",
        authTime: Math.floor(Date.now() / 1000),
        expiresAt: Date.now() + 600000,
      });

      const retrieved = await stores.authorizationCodes.get("test-code");
      expect(retrieved).toBeDefined();
      expect(retrieved!.userId).toBe("user-123");

      await stores.authorizationCodes.delete("test-code");
      const deleted = await stores.authorizationCodes.get("test-code");
      expect(deleted).toBeNull();
    });

    it("should store and retrieve refresh tokens", async () => {
      const config = createTestConfig();
      const { stores } = createOIDCProvider(config);

      await stores.refreshTokens.set({
        token: "test-refresh",
        userId: "user-123",
        clientId: "test-client",
        scope: "openid profile offline_access",
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
      });

      const retrieved = await stores.refreshTokens.get("test-refresh");
      expect(retrieved).toBeDefined();
      expect(retrieved!.userId).toBe("user-123");
    });

    it("should store and retrieve consent", async () => {
      const config = createTestConfig();
      const { stores } = createOIDCProvider(config);

      await stores.consent.set({
        userId: "user-123",
        clientId: "test-client",
        scopes: ["openid", "profile"],
        grantedAt: Date.now(),
      });

      const retrieved = await stores.consent.get("user-123", "test-client");
      expect(retrieved).toBeDefined();
      expect(retrieved!.scopes).toContain("openid");
    });
  });
});
