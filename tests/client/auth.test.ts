import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AuthManager,
  createAuthManager,
  MemoryStorage,
  TokenManager,
  createTokenManager,
  OIDCClient,
  createOIDCClient,
} from "../../src/client/auth";

let originalFetch: typeof global.fetch;

const mockOIDCConfig = {
  issuer: "https://auth.example.com",
  clientId: "test-client",
  redirectUri: "http://localhost:3000/callback",
  scopes: ["openid", "profile", "email"],
};

const mockDiscoveryResponse = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  userinfo_endpoint: "https://auth.example.com/userinfo",
  jwks_uri: "https://auth.example.com/jwks",
  end_session_endpoint: "https://auth.example.com/logout",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

const mockTokenResponse = {
  access_token: "test-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "test-refresh-token",
  id_token: "test-id-token",
  scope: "openid profile email",
};

const mockUserInfo = {
  sub: "user-123",
  email: "test@example.com",
  email_verified: true,
  name: "Test User",
};

describe("Client Auth", () => {
  describe("MemoryStorage", () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    it("should store and retrieve values", async () => {
      await storage.set("key", "value");
      const result = await storage.get("key");
      expect(result).toBe("value");
    });

    it("should return null for missing keys", async () => {
      const result = await storage.get("missing");
      expect(result).toBeNull();
    });

    it("should remove values", async () => {
      await storage.set("key", "value");
      await storage.remove("key");
      const result = await storage.get("key");
      expect(result).toBeNull();
    });

    it("should clear all values", async () => {
      await storage.set("key1", "value1");
      await storage.set("key2", "value2");
      await storage.clear();
      expect(await storage.get("key1")).toBeNull();
      expect(await storage.get("key2")).toBeNull();
    });
  });

  describe("OIDCClient", () => {
    let client: OIDCClient;

    beforeEach(() => {
      originalFetch = global.fetch;
      client = createOIDCClient(mockOIDCConfig);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDiscoveryResponse),
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("should fetch discovery document", async () => {
      const discovery = await client.fetchDiscovery();

      expect(discovery.issuer).toBe("https://auth.example.com");
      expect(discovery.authorization_endpoint).toBe(
        "https://auth.example.com/authorize"
      );
    });

    it("should cache discovery document", async () => {
      await client.fetchDiscovery();
      await client.fetchDiscovery();

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should generate PKCE challenge", async () => {
      const challenge = await client.generatePKCEChallenge();

      expect(challenge.codeVerifier).toBeDefined();
      expect(challenge.codeChallenge).toBeDefined();
      expect(challenge.state).toBeDefined();
      expect(challenge.nonce).toBeDefined();
      expect(challenge.codeVerifier.length).toBeGreaterThan(40);
    });

    it("should build authorization URL with PKCE", async () => {
      const challenge = await client.generatePKCEChallenge();
      const authUrl = await client.buildAuthorizationUrl(challenge);

      const url = new URL(authUrl);
      expect(url.origin + url.pathname).toBe(
        "https://auth.example.com/authorize"
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("test-client");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/callback"
      );
      expect(url.searchParams.get("scope")).toBe("openid profile email");
      expect(url.searchParams.get("state")).toBe(challenge.state);
      expect(url.searchParams.get("nonce")).toBe(challenge.nonce);
      expect(url.searchParams.get("code_challenge")).toBe(
        challenge.codeChallenge
      );
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("should exchange code for tokens", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDiscoveryResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        });

      const tokens = await client.exchangeCodeForTokens(
        "test-code",
        "test-verifier"
      );

      expect(tokens.access_token).toBe("test-access-token");
      expect(tokens.refresh_token).toBe("test-refresh-token");
      expect(tokens.id_token).toBe("test-id-token");
    });

    it("should refresh tokens", async () => {
      const newTokenResponse = {
        ...mockTokenResponse,
        access_token: "new-access-token",
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDiscoveryResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newTokenResponse),
        });

      const tokens = await client.refreshTokens("test-refresh-token");

      expect(tokens.access_token).toBe("new-access-token");
    });

    it("should fetch user info", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDiscoveryResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockUserInfo),
        });

      const userInfo = await client.fetchUserInfo("test-access-token");

      expect(userInfo.sub).toBe("user-123");
      expect(userInfo.email).toBe("test@example.com");
    });

    it("should parse callback params", () => {
      const params = client.parseCallbackParams(
        "http://localhost:3000/callback?code=test-code&state=test-state"
      );

      expect(params.code).toBe("test-code");
      expect(params.state).toBe("test-state");
    });

    it("should parse callback error params", () => {
      const params = client.parseCallbackParams(
        "http://localhost:3000/callback?error=access_denied&error_description=User+denied+access"
      );

      expect(params.error).toBe("access_denied");
      expect(params.errorDescription).toBe("User denied access");
    });
  });

  describe("TokenManager", () => {
    let storage: MemoryStorage;
    let oidcClient: OIDCClient;
    let tokenManager: TokenManager;

    beforeEach(() => {
      originalFetch = global.fetch;
      storage = new MemoryStorage();
      oidcClient = createOIDCClient(mockOIDCConfig);
      tokenManager = createTokenManager(storage, oidcClient, mockOIDCConfig);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDiscoveryResponse),
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("should store and retrieve tokens", async () => {
      const tokens = {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      await tokenManager.setTokens(tokens);
      const retrieved = tokenManager.getTokens();

      expect(retrieved?.accessToken).toBe("test-access-token");
      expect(retrieved?.refreshToken).toBe("test-refresh-token");
    });

    it("should clear tokens", async () => {
      await tokenManager.setTokens({
        accessToken: "test",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      await tokenManager.clearTokens();
      expect(tokenManager.getTokens()).toBeNull();
    });

    it("should detect expired tokens", async () => {
      await tokenManager.setTokens({
        accessToken: "test",
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      });

      expect(tokenManager.isExpired()).toBe(true);
    });

    it("should not return expired access token", async () => {
      await tokenManager.setTokens({
        accessToken: "test",
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      });

      expect(tokenManager.getAccessToken()).toBeNull();
    });

    it("should store and retrieve PKCE challenge", async () => {
      const challenge = {
        codeVerifier: "test-verifier",
        codeChallenge: "test-challenge",
        state: "test-state",
        nonce: "test-nonce",
      };

      await tokenManager.storePKCEChallenge(challenge);
      const retrieved = await tokenManager.getPKCEChallenge();

      expect(retrieved?.codeVerifier).toBe("test-verifier");
      expect(retrieved?.state).toBe("test-state");
    });
  });

  describe("AuthManager", () => {
    let auth: AuthManager;

    beforeEach(() => {
      originalFetch = global.fetch;
      auth = createAuthManager();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDiscoveryResponse),
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("should initialize with unauthenticated state", () => {
      auth.configure(mockOIDCConfig);
      const state = auth.getState();

      expect(state.status).toBe("unauthenticated");
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
    });

    it("should throw if not configured", async () => {
      await expect(auth.initialize()).rejects.toThrow("Auth not configured");
    });

    it("should subscribe to state changes", async () => {
      const callback = vi.fn();
      const unsubscribe = auth.subscribe(callback);

      auth.configure(mockOIDCConfig);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ status: "unauthenticated" })
      );

      unsubscribe();
    });

    it("should return access token when authenticated", async () => {
      auth.configure(mockOIDCConfig);

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDiscoveryResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockUserInfo),
        });

      const oidcClient = createOIDCClient(mockOIDCConfig);
      const challenge = await oidcClient.generatePKCEChallenge();

      const storage = new MemoryStorage();
      await storage.set(
        "covara_auth_pkce",
        JSON.stringify(challenge)
      );

      auth.configure({
        ...mockOIDCConfig,
        storage,
      });

      const callbackUrl = `http://localhost:3000/callback?code=test-code&state=${challenge.state}`;
      await auth.handleCallback(callbackUrl);

      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.getAccessToken()).toBe("test-access-token");
      expect(auth.getUser()).toEqual(mockUserInfo);
    });

    it("should handle logout", async () => {
      auth.configure(mockOIDCConfig);

      const callback = vi.fn();
      auth.on("loggedOut", callback);

      await auth.logout({ localOnly: true });

      expect(callback).toHaveBeenCalled();
      expect(auth.isAuthenticated()).toBe(false);
    });

    it("should handle callback errors", async () => {
      auth.configure(mockOIDCConfig);

      const callbackUrl =
        "http://localhost:3000/callback?error=access_denied&error_description=User+denied+access";

      await expect(auth.handleCallback(callbackUrl)).rejects.toThrow(
        "User denied access"
      );
    });

    it("should detect state mismatch", async () => {
      const storage = new MemoryStorage();
      await storage.set(
        "covara_auth_pkce",
        JSON.stringify({
          codeVerifier: "test-verifier",
          codeChallenge: "test-challenge",
          state: "correct-state",
          nonce: "test-nonce",
        })
      );

      auth.configure({
        ...mockOIDCConfig,
        storage,
      });

      const callbackUrl =
        "http://localhost:3000/callback?code=test-code&state=wrong-state";

      await expect(auth.handleCallback(callbackUrl)).rejects.toThrow(
        "State mismatch"
      );
    });
  });
});
