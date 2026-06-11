import { Hono } from "hono";
import * as crypto from "node:crypto";
import {
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
  TokenService,
} from "../types";
import { readFormBody } from "../body";
import { authenticateClient } from "./client-auth";

const base64UrlEncode = (buffer: Buffer): string => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

interface TokenEndpointConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  tokenService: TokenService;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createTokenEndpoint = ({
  config,
  stores,
  tokenService,
  findUserById,
}: TokenEndpointConfig): Hono => {
  const router = new Hono();

  router.post("/", async (c) => {
    const body = await readFormBody(c);

    const clientAuth = await authenticateClient(c, body, stores.clients);
    if (!clientAuth.success || !clientAuth.client) {
      return c.json(
        {
          error: "invalid_client",
          error_description: clientAuth.error ?? "Client authentication failed",
        },
        401
      );
    }

    const client = clientAuth.client;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, redirect_uri, code_verifier } = body;

      if (!code) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "code is required",
          },
          400
        );
      }

      const authCode = await stores.authorizationCodes.get(code);
      if (!authCode) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code not found or expired",
          },
          400
        );
      }

      await stores.authorizationCodes.delete(code);

      if (authCode.clientId !== client.id) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code was not issued to this client",
          },
          400
        );
      }

      if (authCode.redirectUri !== redirect_uri) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "redirect_uri does not match",
          },
          400
        );
      }

      if (Date.now() > authCode.expiresAt) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code has expired",
          },
          400
        );
      }

      if (authCode.codeChallenge) {
        if (!code_verifier) {
          return c.json(
            {
              error: "invalid_grant",
              error_description: "code_verifier is required",
            },
            400
          );
        }

        const method = authCode.codeChallengeMethod ?? "S256";
        let computedChallenge: string;

        if (method === "S256") {
          const hash = crypto.createHash("sha256").update(code_verifier).digest();
          computedChallenge = base64UrlEncode(hash);
        } else {
          computedChallenge = code_verifier;
        }

        if (computedChallenge !== authCode.codeChallenge) {
          return c.json(
            {
              error: "invalid_grant",
              error_description: "Invalid code_verifier",
            },
            400
          );
        }
      }

      const user = await findUserById(authCode.userId);
      if (!user) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "User not found",
          },
          400
        );
      }

      const tokens = await tokenService.generateTokenSet({
        user,
        client,
        scope: authCode.scope,
        nonce: authCode.nonce,
        authTime: authCode.authTime,
        includeIdToken: authCode.scope.split(" ").includes("openid"),
        includeRefreshToken: authCode.scope.split(" ").includes("offline_access"),
      });

      return c.json(tokens);
    }

    if (grantType === "refresh_token") {
      const { refresh_token, scope: requestedScope } = body;

      if (!refresh_token) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "refresh_token is required",
          },
          400
        );
      }

      const refreshData = await stores.refreshTokens.get(refresh_token);
      if (!refreshData) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token not found or expired",
          },
          400
        );
      }

      if (refreshData.clientId !== client.id) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token was not issued to this client",
          },
          400
        );
      }

      if (Date.now() > refreshData.expiresAt) {
        await stores.refreshTokens.delete(refresh_token);
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token has expired",
          },
          400
        );
      }

      const user = await findUserById(refreshData.userId);
      if (!user) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "User not found",
          },
          400
        );
      }

      let effectiveScope = refreshData.scope;
      if (requestedScope) {
        const requestedScopes = requestedScope.split(" ");
        const originalScopes = refreshData.scope.split(" ");
        const narrowed = requestedScopes.filter((s: string) => originalScopes.includes(s));
        if (narrowed.length !== requestedScopes.length) {
          return c.json(
            {
              error: "invalid_scope",
              error_description: "Requested scope exceeds original grant",
            },
            400
          );
        }
        effectiveScope = narrowed.join(" ");
      }

      if (config.tokens?.refreshToken?.rotateOnUse !== false) {
        await stores.refreshTokens.delete(refresh_token);
      }

      const tokens = await tokenService.generateTokenSet({
        user,
        client,
        scope: effectiveScope,
        includeIdToken: false,
        includeRefreshToken: true,
      });

      return c.json(tokens);
    }

    return c.json(
      {
        error: "unsupported_grant_type",
        error_description: `Grant type '${grantType}' is not supported`,
      },
      400
    );
  });

  return router;
};
