import { Hono, type MiddlewareHandler } from "hono";
import {
  AuthBackend,
  OIDCClient,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
  TokenService,
} from "./types";
import { createKeyManager } from "./keys";
import { createTokenService } from "./tokens";
import { generateDiscoveryDocument } from "./discovery";
import { createStores } from "./stores";
import {
  createAuthorizeEndpoint,
  createTokenEndpoint,
  createUserInfoEndpoint,
  createJWKSEndpoint,
  createLogoutEndpoint,
  createRevocationEndpoint,
  createIntrospectionEndpoint,
} from "./endpoints";
import { createRegisterEndpoint } from "./endpoints/register";
import { createOIDCRateLimiter } from "./rate-limit";
import { createLoginHandler, createConsentHandler } from "./ui";
import {
  createEmailPasswordBackend,
  createFederatedBackend,
  createPassportBackend,
} from "./backends";
import { createExternalAuthRoutes } from "./complete-login";
import { InMemorySessionStore, SessionStore } from "@/auth/types";

export interface OIDCProviderResult {
  router: Hono;
  middleware: MiddlewareHandler;
  stores: OIDCProviderStores;
  tokenService: TokenService;
}

export const createOIDCProvider = (config: OIDCProviderConfig): OIDCProviderResult => {
  const keyManager = createKeyManager(config.keys);

  const clients: OIDCClient[] = Array.isArray(config.clients)
    ? config.clients
    : [];

  const stores = createStores(config.stores, clients);

  if (Array.isArray(config.clients)) {
    for (const client of config.clients) {
      stores.clients.set(client);
    }
  }

  const tokenService = createTokenService(config, keyManager, stores.refreshTokens);

  const sessionStore: SessionStore =
    (config.stores?.sessionStore as SessionStore) ?? new InMemorySessionStore();

  const backends: AuthBackend[] = [];

  const findUserById = async (id: string): Promise<OIDCUser | null> => {
    if (config.backends.emailPassword?.findUserById) {
      const user = await config.backends.emailPassword.findUserById(id);
      if (user) return user;
    }
    if (config.backends.passport?.findUserById) {
      return config.backends.passport.findUserById(id);
    }
    return null;
  };

  if (config.backends.emailPassword?.enabled) {
    backends.push(createEmailPasswordBackend(config.backends.emailPassword));
  }

  if (config.backends.federated && config.backends.federated.length > 0) {
    backends.push(
      createFederatedBackend({
        providers: config.backends.federated,
        baseUrl: config.baseUrl ?? config.issuer,
        stateStore: stores.state,
        findUserByAccount: async (_provider: string, _providerAccountId: string) => null,
        createUser: async (userInfo: Record<string, unknown>, _provider: string) => ({
          id: userInfo.sub as string,
          email: userInfo.email as string | undefined,
          emailVerified: userInfo.email_verified as boolean | undefined,
          name: userInfo.name as string | undefined,
          givenName: userInfo.given_name as string | undefined,
          familyName: userInfo.family_name as string | undefined,
          picture: userInfo.picture as string | undefined,
        }),
      })
    );
  }

  if (config.backends.passport && config.backends.passport.providers.length > 0) {
    backends.push(
      createPassportBackend({
        providers: config.backends.passport.providers,
        baseUrl: config.baseUrl ?? config.issuer,
        findUserByAccount:
          config.backends.passport.findUserByAccount ??
          (async () => null),
        createUser: config.backends.passport.createUser,
        linkAccount: config.backends.passport.linkAccount,
        stateStore: config.backends.passport.stateStore,
      })
    );
  }

  const router = new Hono();

  router.get("/.well-known/openid-configuration", (c) => {
    return c.json(generateDiscoveryDocument(config));
  });

  const rl = config.security?.rateLimiting;
  if (rl?.jwks) {
    router.use("/jwks", createOIDCRateLimiter({ ...rl.jwks, prefix: "jwks" }));
  }
  if (rl?.token) {
    router.use("/token", createOIDCRateLimiter({ ...rl.token, prefix: "token" }));
  }
  if (rl?.introspect) {
    router.use(
      "/introspect",
      createOIDCRateLimiter({ ...rl.introspect, prefix: "introspect" })
    );
  }

  router.route("/jwks", createJWKSEndpoint(keyManager));

  router.route(
    "/authorize",
    createAuthorizeEndpoint({
      config,
      stores,
      sessionStore,
      findUserById,
    })
  );

  router.route(
    "/token",
    createTokenEndpoint({
      config,
      stores,
      tokenService,
      findUserById,
    })
  );

  router.route(
    "/userinfo",
    createUserInfoEndpoint({
      config,
      tokenService,
      findUserById,
    })
  );

  router.route(
    "/logout",
    createLogoutEndpoint({
      config,
      stores,
      tokenService,
      sessionStore,
    })
  );

  router.route(
    "/revoke",
    createRevocationEndpoint({
      stores,
      tokenService,
    })
  );

  router.route(
    "/introspect",
    createIntrospectionEndpoint({
      stores,
      tokenService,
    })
  );

  router.route(
    config.ui?.loginPath ?? "/login",
    createLoginHandler({
      config,
      stores,
      backends,
      sessionStore,
    })
  );

  router.route(
    config.ui?.consentPath ?? "/consent",
    createConsentHandler({
      config,
      stores,
      findUserById,
      sessionStore,
    })
  );

  router.route(
    "/register",
    createRegisterEndpoint({
      stores,
      registration: config.registration,
    })
  );

  for (const backend of backends) {
    if (backend.initiateExternalAuth && backend.handleExternalCallback) {
      // The provider owns the external redirect/callback routes so a successful
      // callback resumes the pending /authorize interaction (session + auth code).
      router.route(
        `/auth/${backend.name}`,
        createExternalAuthRoutes(backend, { config, stores, sessionStore })
      );
    } else if (backend.getRoutes) {
      router.route(`/auth/${backend.name}`, backend.getRoutes());
    }
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.slice(7);
    const validation = await tokenService.validateAccessToken(token);

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

    c.set("user", {
      id: validation.claims.sub,
      email: user?.email ?? null,
      name: user?.name ?? null,
      image: user?.picture ?? null,
      emailVerified: user?.emailVerified ? new Date() : null,
      sessionId: validation.claims.jti,
      sessionExpiresAt: new Date(validation.claims.exp * 1000),
      metadata: user?.metadata,
    });

    return next();
  };

  return {
    router,
    middleware,
    stores,
    tokenService,
  };
};
