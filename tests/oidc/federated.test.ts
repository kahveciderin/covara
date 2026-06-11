import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createFederatedBackend,
  clearFederatedCaches,
} from "../../src/oidc/backends/federated";
import { createKeyManager } from "../../src/oidc/keys";
import { InMemoryStateStore } from "../../src/oidc/stores";
import { OIDCUser } from "../../src/oidc/types";

const UPSTREAM_ISSUER = "https://upstream.example.com";
const CLIENT_ID = "fed-client";

const buildUpstream = async () => {
  const keyManager = createKeyManager({ algorithm: "RS256" });
  const jwks = await keyManager.getPublicKeys();

  const signIdToken = async (overrides: Record<string, unknown> = {}) =>
    keyManager.signToken({
      iss: UPSTREAM_ISSUER,
      sub: "upstream-user-1",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      email: "fed@example.com",
      ...overrides,
    });

  return { keyManager, jwks, signIdToken };
};

describe("federated id_token verification", () => {
  let stateStore: InMemoryStateStore;
  let backend: ReturnType<typeof createFederatedBackend>;
  let upstream: Awaited<ReturnType<typeof buildUpstream>>;
  let idTokenToReturn: string;
  let badSignerKeyManager: ReturnType<typeof createKeyManager>;

  const setupFetch = () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes(".well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: UPSTREAM_ISSUER,
            authorization_endpoint: `${UPSTREAM_ISSUER}/authorize`,
            token_endpoint: `${UPSTREAM_ISSUER}/token`,
            userinfo_endpoint: `${UPSTREAM_ISSUER}/userinfo`,
            jwks_uri: `${UPSTREAM_ISSUER}/jwks`,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/jwks")) {
        return new Response(JSON.stringify({ keys: upstream.jwks }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "fed-access", id_token: idTokenToReturn }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/userinfo")) {
        return new Response(
          JSON.stringify({ sub: "upstream-user-1", email: "fed@example.com" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
  };

  beforeEach(async () => {
    clearFederatedCaches();
    upstream = await buildUpstream();
    badSignerKeyManager = createKeyManager({ algorithm: "RS256" });
    stateStore = new InMemoryStateStore();
    const created: OIDCUser[] = [];
    backend = createFederatedBackend({
      providers: [
        {
          name: "upstream",
          clientId: CLIENT_ID,
          clientSecret: "fed-secret",
          issuer: UPSTREAM_ISSUER,
        },
      ],
      baseUrl: "https://auth.example.com",
      stateStore,
      findUserByAccount: async () => null,
      createUser: async (info) => {
        const u: OIDCUser = { id: info.sub as string, email: info.email as string };
        created.push(u);
        return u;
      },
    });
    setupFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runCallback = async (state: string) => {
    const app = new Hono();
    let result: any;
    app.get("/cb", async (c) => {
      result = await backend.handleExternalCallback!(c);
      return c.json({});
    });
    await app.request(`/cb?code=auth-code&state=${state}`);
    return result;
  };

  const seedState = async (state: string) => {
    await stateStore.set(state, {
      provider: "upstream",
      nonce: "n-1",
      codeVerifier: "verifier",
    });
  };

  it("accepts a validly signed id_token", async () => {
    idTokenToReturn = await upstream.signIdToken({ nonce: "n-1" });
    await seedState("good-state");
    const result = await runCallback("good-state");
    expect(result.success).toBe(true);
    expect(result.user.email).toBe("fed@example.com");
  });

  it("rejects an id_token signed by an unknown key", async () => {
    idTokenToReturn = await badSignerKeyManager.signToken({
      iss: UPSTREAM_ISSUER,
      sub: "upstream-user-1",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    });
    await seedState("bad-sig-state");
    const result = await runCallback("bad-sig-state");
    expect(result.success).toBe(false);
    expect(result.error).toContain("verification failed");
  });

  it("rejects an id_token with the wrong audience", async () => {
    idTokenToReturn = await upstream.signIdToken({ aud: "someone-else" });
    await seedState("bad-aud-state");
    const result = await runCallback("bad-aud-state");
    expect(result.success).toBe(false);
  });

  it("rejects an expired id_token", async () => {
    idTokenToReturn = await upstream.signIdToken({
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    await seedState("expired-state");
    const result = await runCallback("expired-state");
    expect(result.success).toBe(false);
  });

  it("rejects a nonce mismatch", async () => {
    idTokenToReturn = await upstream.signIdToken({ nonce: "wrong-nonce" });
    await seedState("nonce-state");
    const result = await runCallback("nonce-state");
    expect(result.success).toBe(false);
    expect(result.error).toContain("nonce");
  });
});
