import { Hono, type Context } from "hono";
import {
  OIDCProviderConfig,
  OIDCUser,
  TokenService,
} from "../types";

interface UserInfoEndpointConfig {
  config: OIDCProviderConfig;
  tokenService: TokenService;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createUserInfoEndpoint = ({
  config,
  tokenService,
  findUserById,
}: UserInfoEndpointConfig): Hono => {
  const router = new Hono();

  const handler = async (c: Context): Promise<Response> => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          error: "invalid_token",
          error_description: "Bearer token required",
        },
        401
      );
    }

    const accessToken = authHeader.slice(7);
    const validation = await tokenService.validateAccessToken(accessToken);

    if (!validation.valid || !validation.claims) {
      return c.json(
        {
          error: "invalid_token",
          error_description: "Invalid or expired access token",
        },
        401
      );
    }

    const user = await findUserById(validation.claims.sub);
    if (!user) {
      return c.json(
        {
          error: "invalid_token",
          error_description: "User not found",
        },
        401
      );
    }

    const scopes = validation.claims.scope.split(" ");
    const claims: Record<string, unknown> = {
      sub: user.id,
    };

    if (scopes.includes("email")) {
      if (user.email) claims.email = user.email;
      claims.email_verified = user.emailVerified ?? false;
    }

    if (scopes.includes("profile")) {
      if (user.name) claims.name = user.name;
      if (user.givenName) claims.given_name = user.givenName;
      if (user.familyName) claims.family_name = user.familyName;
      if (user.picture) claims.picture = user.picture;
      if (user.locale) claims.locale = user.locale;
    }

    if (config.hooks?.getUserInfoClaims) {
      const customClaims = await config.hooks.getUserInfoClaims(user, scopes);
      Object.assign(claims, customClaims);
    }

    return c.json(claims);
  };

  router.get("/", handler);
  router.post("/", handler);

  return router;
};
