import { Hono } from "hono";
import { OIDCProviderStores, TokenService } from "../types";
import { readFormBody } from "../body";
import { authenticateClient } from "./client-auth";

interface IntrospectionEndpointConfig {
  stores: OIDCProviderStores;
  tokenService: TokenService;
}

export const createIntrospectionEndpoint = ({
  stores,
  tokenService,
}: IntrospectionEndpointConfig): Hono => {
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

    const token = body.token;
    if (!token) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "token is required",
        },
        400
      );
    }

    const hint = body.token_type_hint;

    if (hint !== "access_token") {
      const refreshData = await stores.refreshTokens.get(token);
      if (refreshData) {
        return c.json({
          active: true,
          scope: refreshData.scope,
          client_id: refreshData.clientId,
          sub: refreshData.userId,
          exp: Math.floor(refreshData.expiresAt / 1000),
          iat: Math.floor(refreshData.createdAt / 1000),
          token_type: "refresh_token",
        });
      }
    }

    const validation = await tokenService.validateAccessToken(token);
    if (validation.valid && validation.claims) {
      const claims = validation.claims;
      return c.json({
        active: true,
        scope: claims.scope,
        client_id: claims.client_id,
        sub: claims.sub,
        exp: claims.exp,
        iat: claims.iat,
        token_type: "Bearer",
        aud: claims.aud,
        iss: claims.iss,
        jti: claims.jti,
      });
    }

    return c.json({ active: false });
  });

  return router;
};
