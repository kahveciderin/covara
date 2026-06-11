import { Hono, type Context } from "hono";
import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  AuthBackend,
  AuthBackendResult,
  FederatedProvider,
  JWK,
  OIDCDiscoveryDocument,
  OIDCUser,
  StateStore,
} from "../types";

const base64UrlEncode = (buffer: Buffer): string => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const discoveryCache = new Map<string, { doc: OIDCDiscoveryDocument; expiresAt: number }>();
const jwksCache = new Map<string, { keys: JWK[]; expiresAt: number }>();

export const clearFederatedCaches = (): void => {
  discoveryCache.clear();
  jwksCache.clear();
};

const fetchJwks = async (jwksUri: string): Promise<JWK[]> => {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.keys;
  }

  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUri}`);
  }

  const body = (await response.json()) as { keys: JWK[] };
  const keys = body.keys ?? [];
  jwksCache.set(jwksUri, { keys, expiresAt: Date.now() + 3600000 });
  return keys;
};

const jwkToPublicKey = (jwk: JWK): crypto.KeyObject => {
  return crypto.createPublicKey({
    key: jwk as unknown as JsonWebKey,
    format: "jwk",
  });
};

const verifyIdToken = async (
  idToken: string,
  discovery: OIDCDiscoveryDocument,
  provider: FederatedProvider
): Promise<jwt.JwtPayload> => {
  const decoded = jwt.decode(idToken, { complete: true }) as {
    header: { kid?: string; alg?: string };
  } | null;
  if (!decoded?.header) {
    throw new Error("Invalid id_token format");
  }

  const keys = await fetchJwks(discovery.jwks_uri);
  const candidates = decoded.header.kid
    ? keys.filter((k) => k.kid === decoded.header.kid)
    : keys;

  if (candidates.length === 0) {
    throw new Error("No matching JWKS key for id_token");
  }

  let lastError: unknown;
  for (const jwk of candidates) {
    try {
      const payload = jwt.verify(idToken, jwkToPublicKey(jwk), {
        algorithms: jwk.alg ? [jwk.alg as jwt.Algorithm] : undefined,
        issuer: provider.issuer,
        audience: provider.clientId,
      }) as jwt.JwtPayload;
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `id_token signature verification failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
};

const fetchDiscovery = async (issuer: string): Promise<OIDCDiscoveryDocument> => {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.doc;
  }

  const url = issuer.endsWith("/")
    ? `${issuer}.well-known/openid-configuration`
    : `${issuer}/.well-known/openid-configuration`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC discovery document from ${url}`);
  }

  const doc = (await response.json()) as OIDCDiscoveryDocument;
  discoveryCache.set(issuer, { doc, expiresAt: Date.now() + 3600000 });

  return doc;
};

interface FederatedBackendConfig {
  providers: FederatedProvider[];
  baseUrl: string;
  stateStore: StateStore;
  findUserByAccount: (provider: string, providerAccountId: string) => Promise<OIDCUser | null>;
  createUser: (userInfo: Record<string, unknown>, provider: string) => Promise<OIDCUser>;
  linkAccount?: (userId: string, provider: string, providerAccountId: string) => Promise<void>;
}

export const createFederatedBackend = (config: FederatedBackendConfig): AuthBackend => {
  const providerMap = new Map<string, FederatedProvider>();
  for (const provider of config.providers) {
    providerMap.set(provider.name, provider);
  }

  return {
    name: "federated",

    async authenticate(_c: Context): Promise<AuthBackendResult> {
      return { success: false, error: "Use handleExternalCallback for federated auth" };
    },

    getExternalProviders() {
      return config.providers.map((p) => ({
        name: p.name,
        authUrl: `/auth/federated/${p.name}`,
      }));
    },

    async initiateExternalAuth(providerName: string, c: Context): Promise<Response> {
      const provider = providerMap.get(providerName);
      if (!provider) {
        return c.json({ error: `Unknown provider: ${providerName}` }, 400);
      }

      const discovery = await fetchDiscovery(provider.issuer);

      const state = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
      const codeChallenge = base64UrlEncode(
        crypto.createHash("sha256").update(codeVerifier).digest()
      );

      const interactionId = c.req.query("interaction");

      await config.stateStore.set(state, {
        provider: providerName,
        nonce,
        codeVerifier,
        returnTo: interactionId ? `/login?interaction=${interactionId}` : undefined,
      });

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set("client_id", provider.clientId);
      authUrl.searchParams.set("redirect_uri", `${config.baseUrl}/auth/federated/callback`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set(
        "scope",
        (provider.scopes ?? ["openid", "email", "profile"]).join(" ")
      );
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("nonce", nonce);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      return c.redirect(authUrl.toString(), 302);
    },

    async handleExternalCallback(c: Context): Promise<AuthBackendResult> {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      const error_description = c.req.query("error_description");

      if (error) {
        return { success: false, error: error_description ?? error };
      }

      if (!code || !state) {
        return { success: false, error: "Missing code or state parameter" };
      }

      const stateData = await config.stateStore.get(state);
      if (!stateData) {
        return { success: false, error: "Invalid or expired state" };
      }

      await config.stateStore.delete(state);

      const provider = providerMap.get(stateData.provider);
      if (!provider) {
        return { success: false, error: `Unknown provider: ${stateData.provider}` };
      }

      const discovery = await fetchDiscovery(provider.issuer);

      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${config.baseUrl}/auth/federated/callback`,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: stateData.codeVerifier,
      });

      const tokenResponse = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        return { success: false, error: `Token exchange failed: ${errorText}` };
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        id_token?: string;
      };

      let verifiedClaims: jwt.JwtPayload | null = null;
      if (tokens.id_token) {
        try {
          verifiedClaims = await verifyIdToken(tokens.id_token, discovery, provider);
        } catch (error) {
          return {
            success: false,
            error: `id_token verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }

        if (verifiedClaims.nonce && verifiedClaims.nonce !== stateData.nonce) {
          return { success: false, error: "id_token nonce mismatch" };
        }
      }

      const userinfoResponse = await fetch(discovery.userinfo_endpoint!, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userinfoResponse.ok) {
        return { success: false, error: "Failed to fetch user info" };
      }

      const userInfo = (await userinfoResponse.json()) as Record<string, unknown>;

      if (
        verifiedClaims?.sub &&
        userInfo.sub &&
        verifiedClaims.sub !== userInfo.sub
      ) {
        return { success: false, error: "userinfo sub does not match id_token sub" };
      }

      const providerAccountId = (verifiedClaims?.sub ?? userInfo.sub) as string;

      let user = await config.findUserByAccount(stateData.provider, providerAccountId);

      if (!user) {
        user = provider.mapUser
          ? await provider.mapUser(userInfo)
          : await config.createUser(userInfo, stateData.provider);

        if (config.linkAccount) {
          await config.linkAccount(user.id, stateData.provider, providerAccountId);
        }
      }

      return {
        success: true,
        user,
        authTime: Math.floor(Date.now() / 1000),
        amr: ["fed"],
        provider: stateData.provider,
      };
    },

    getRoutes() {
      const router = new Hono();

      router.get("/callback", async (c) => {
        const result = await this.handleExternalCallback!(c);

        if (!result.success) {
          return c.json({ error: result.error }, 400);
        }

        return c.json({ success: true, user: result.user });
      });

      router.get("/:provider", async (c) => {
        return this.initiateExternalAuth!(c.req.param("provider"), c);
      });

      return router;
    },
  };
};
