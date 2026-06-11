import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  AccessTokenClaims,
  IDTokenClaims,
  KeyManager,
  OIDCClient,
  OIDCProviderConfig,
  OIDCUser,
  RefreshTokenStore,
  TokenResponse,
  TokenService,
} from "../types";
import { algorithmToHash } from "../util";

const base64UrlEncode = (buffer: Buffer): string => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const computeAtHash = (accessToken: string, algorithm: string): string => {
  const hashAlg = algorithmToHash(algorithm);
  const hash = crypto.createHash(hashAlg).update(accessToken).digest();
  const halfHash = hash.subarray(0, hash.length / 2);
  return base64UrlEncode(halfHash);
};

export const validateIdTokenNonce = (
  idToken: string,
  expectedNonce: string
): boolean => {
  const decoded = jwt.decode(idToken) as { nonce?: unknown } | null;
  if (!decoded || typeof decoded !== "object") {
    return false;
  }
  return decoded.nonce === expectedNonce;
};

interface ResolvedTokenConfig {
  accessToken: { ttlSeconds: number; format: "jwt" | "opaque" };
  idToken: { ttlSeconds: number };
  refreshToken: { enabled: boolean; ttlSeconds: number; rotateOnUse: boolean };
  authorizationCode: { ttlSeconds: number };
}

export const createTokenService = (
  config: OIDCProviderConfig,
  keyManager: KeyManager,
  refreshTokenStore: RefreshTokenStore
): TokenService => {
  const tokenConfig: ResolvedTokenConfig = {
    accessToken: {
      ttlSeconds: config.tokens?.accessToken?.ttlSeconds ?? 3600,
      format: config.tokens?.accessToken?.format ?? "jwt",
    },
    idToken: {
      ttlSeconds: config.tokens?.idToken?.ttlSeconds ?? 3600,
    },
    refreshToken: {
      enabled: config.tokens?.refreshToken?.enabled ?? true,
      ttlSeconds: config.tokens?.refreshToken?.ttlSeconds ?? 30 * 24 * 60 * 60,
      rotateOnUse: config.tokens?.refreshToken?.rotateOnUse ?? true,
    },
    authorizationCode: {
      ttlSeconds: config.tokens?.authorizationCode?.ttlSeconds ?? 600,
    },
  };

  const generateAccessToken = async (
    user: OIDCUser,
    client: OIDCClient,
    scope: string
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();

    const claims: AccessTokenClaims = {
      iss: config.issuer,
      sub: user.id,
      aud: client.audiences ?? [config.issuer, client.id],
      exp: now + tokenConfig.accessToken.ttlSeconds,
      iat: now,
      jti,
      scope,
      client_id: client.id,
    };

    if (config.hooks?.getAccessTokenClaims) {
      const customClaims = await config.hooks.getAccessTokenClaims(
        user,
        client,
        scope.split(" ")
      );
      Object.assign(claims, customClaims);
    }

    return keyManager.signToken(claims);
  };

  const generateIdToken = async (
    user: OIDCUser,
    client: OIDCClient,
    scope: string,
    nonce?: string,
    authTime?: number,
    accessToken?: string
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const scopes = scope.split(" ");

    const claims: IDTokenClaims = {
      iss: config.issuer,
      sub: user.id,
      aud: client.id,
      exp: now + tokenConfig.idToken.ttlSeconds,
      iat: now,
    };

    if (authTime) {
      claims.auth_time = authTime;
    }

    if (nonce) {
      claims.nonce = nonce;
    }

    if (accessToken) {
      claims.at_hash = computeAtHash(accessToken, keyManager.getAlgorithm());
    }

    if (scopes.includes("email") && user.email) {
      claims.email = user.email;
      claims.email_verified = user.emailVerified ?? false;
    }

    if (scopes.includes("profile")) {
      if (user.name) claims.name = user.name;
      if (user.givenName) claims.given_name = user.givenName;
      if (user.familyName) claims.family_name = user.familyName;
      if (user.picture) claims.picture = user.picture;
      if (user.locale) claims.locale = user.locale;
    }

    return keyManager.signToken(claims);
  };

  const generateRefreshToken = async (
    user: OIDCUser,
    client: OIDCClient,
    scope: string
  ): Promise<string> => {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();

    await refreshTokenStore.set({
      token,
      userId: user.id,
      clientId: client.id,
      scope,
      createdAt: now,
      expiresAt: now + tokenConfig.refreshToken.ttlSeconds * 1000,
    });

    return token;
  };

  return {
    async generateTokenSet(params): Promise<TokenResponse> {
      const {
        user,
        client,
        scope,
        nonce,
        authTime,
        includeIdToken = true,
        includeRefreshToken = true,
      } = params;

      const accessToken = await generateAccessToken(user, client, scope);

      const response: TokenResponse = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: tokenConfig.accessToken.ttlSeconds,
        scope,
      };

      if (includeIdToken && scope.split(" ").includes("openid")) {
        response.id_token = await generateIdToken(
          user,
          client,
          scope,
          nonce,
          authTime,
          accessToken
        );
      }

      if (
        includeRefreshToken &&
        tokenConfig.refreshToken.enabled &&
        scope.split(" ").includes("offline_access")
      ) {
        response.refresh_token = await generateRefreshToken(user, client, scope);
      }

      if (config.hooks?.onTokenIssued) {
        await config.hooks.onTokenIssued(user.id, client.id, scope.split(" "));
      }

      return response;
    },

    async validateAccessToken(
      token: string
    ): Promise<{ valid: boolean; claims?: AccessTokenClaims }> {
      try {
        const claims = (await keyManager.verifyToken(token)) as AccessTokenClaims;
        const now = Math.floor(Date.now() / 1000);

        if (claims.exp && claims.exp < now) {
          return { valid: false };
        }

        if (claims.iss !== config.issuer) {
          return { valid: false };
        }

        return { valid: true, claims };
      } catch {
        return { valid: false };
      }
    },

    async decodeIdToken(token: string): Promise<IDTokenClaims> {
      return (await keyManager.verifyToken(token)) as IDTokenClaims;
    },

    async revokeRefreshToken(token: string): Promise<void> {
      await refreshTokenStore.delete(token);
    },
  };
};
