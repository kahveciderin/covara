import { Hono } from "hono";
import { OIDCProviderStores, TokenService } from "../types";
import { readFormBody } from "../body";
import { authenticateClient } from "./client-auth";

interface RevocationEndpointConfig {
  stores: OIDCProviderStores;
  tokenService: TokenService;
}

export const createRevocationEndpoint = ({
  stores,
  tokenService,
}: RevocationEndpointConfig): Hono => {
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

    const client = clientAuth.client;

    const refreshData = await stores.refreshTokens.get(token);
    if (refreshData && refreshData.clientId === client.id) {
      await tokenService.revokeRefreshToken(token);
    }

    return c.body(null, 200);
  });

  return router;
};
