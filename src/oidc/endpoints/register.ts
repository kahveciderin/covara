import { Hono } from "hono";
import * as crypto from "node:crypto";
import {
  GrantType,
  OIDCClient,
  OIDCProviderStores,
  RegistrationConfig,
  ResponseType,
  TokenAuthMethod,
} from "../types";
import { readFormBody } from "../body";
import { readJsonBody } from "@/server/request";

interface RegisterEndpointConfig {
  stores: OIDCProviderStores;
  registration?: RegistrationConfig;
}

const isValidRedirectUri = (uri: string): boolean => {
  try {
    const url = new URL(uri);
    return url.protocol.length > 0 && url.hostname.length > 0;
  } catch {
    return uri.includes(":");
  }
};

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return value as string[];
};

export const createRegisterEndpoint = ({
  stores,
  registration,
}: RegisterEndpointConfig): Hono => {
  const router = new Hono();

  router.post("/", async (c) => {
    if (!registration?.enabled) {
      return c.json(
        {
          error: "registration_not_supported",
          error_description: "Dynamic client registration is disabled",
        },
        404
      );
    }

    if (registration.initialAccessToken) {
      const authHeader = c.req.header("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
      if (token !== registration.initialAccessToken) {
        return c.json(
          {
            error: "invalid_token",
            error_description: "Initial access token required",
          },
          403
        );
      }
    }

    const contentType = c.req.header("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await readJsonBody(c)) as Record<string, unknown>)
      : ((await readFormBody(c)) as Record<string, unknown>);

    const redirectUris = asStringArray(body.redirect_uris);
    if (!redirectUris || redirectUris.length === 0) {
      return c.json(
        {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris is required and must be a non-empty array",
        },
        400
      );
    }

    for (const uri of redirectUris) {
      if (!isValidRedirectUri(uri)) {
        return c.json(
          {
            error: "invalid_redirect_uri",
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          400
        );
      }
    }

    const tokenEndpointAuthMethod =
      (body.token_endpoint_auth_method as TokenAuthMethod) ?? "client_secret_basic";
    const isPublic = tokenEndpointAuthMethod === "none";

    const grantTypes =
      (asStringArray(body.grant_types) as GrantType[] | null) ??
      (["authorization_code"] as GrantType[]);
    const responseTypes =
      (asStringArray(body.response_types) as ResponseType[] | null) ??
      (["code"] as ResponseType[]);

    const scope =
      typeof body.scope === "string"
        ? body.scope.split(" ").filter(Boolean)
        : (registration.defaultScopes ?? ["openid", "profile", "email"]);

    const clientId = crypto.randomUUID();
    const clientSecret = isPublic
      ? undefined
      : crypto.randomBytes(32).toString("hex");

    const client: OIDCClient = {
      id: clientId,
      secret: clientSecret,
      name:
        typeof body.client_name === "string" ? body.client_name : clientId,
      redirectUris,
      postLogoutRedirectUris: asStringArray(body.post_logout_redirect_uris) ?? undefined,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod,
      scopes: scope,
    };

    await stores.clients.set(client);

    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      scope: scope.join(" "),
      client_name: client.name,
    };

    if (clientSecret) {
      response.client_secret = clientSecret;
      response.client_secret_expires_at = 0;
    }

    return c.json(response, 201);
  });

  return router;
};
