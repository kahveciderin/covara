import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import * as crypto from "node:crypto";
import {
  AuthorizationCode,
  AuthorizationRequest,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
} from "../types";
import { SessionStore } from "@/auth/types";
import { redirectUriAllowed } from "../util";

const parseAuthorizationRequest = (
  query: Record<string, string>
): AuthorizationRequest | { error: string; error_description: string } => {
  const responseType = query.response_type;
  const clientId = query.client_id;
  const redirectUri = query.redirect_uri;
  const scope = query.scope;
  const state = query.state;

  if (!responseType) {
    return { error: "invalid_request", error_description: "response_type is required" };
  }
  if (!clientId) {
    return { error: "invalid_request", error_description: "client_id is required" };
  }
  if (!redirectUri) {
    return { error: "invalid_request", error_description: "redirect_uri is required" };
  }
  if (!scope) {
    return { error: "invalid_request", error_description: "scope is required" };
  }
  if (!state) {
    return { error: "invalid_request", error_description: "state is required" };
  }

  return {
    responseType: responseType as AuthorizationRequest["responseType"],
    clientId,
    redirectUri,
    scope,
    state,
    nonce: query.nonce,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: query.code_challenge_method as "S256" | "plain" | undefined,
    prompt: query.prompt as AuthorizationRequest["prompt"],
    maxAge: query.max_age ? parseInt(query.max_age, 10) : undefined,
    loginHint: query.login_hint,
    acrValues: query.acr_values,
    returnTo: query.return_to,
  };
};

const redirectWithError = (
  c: Context,
  redirectUri: string,
  state: string,
  error: string,
  errorDescription: string
): Response => {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", errorDescription);
  url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
};

const renderError = (c: Context, error: string, description: string): Response => {
  return c.json({ error, error_description: description }, 400);
};

interface AuthorizeEndpointConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  sessionStore?: SessionStore;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createAuthorizeEndpoint = ({
  config,
  stores,
  sessionStore,
}: AuthorizeEndpointConfig): Hono => {
  const router = new Hono();

  const extractSession = async (c: Context): Promise<{ userId: string; authTime: number } | null> => {
    const sessionId = getCookie(c, "oidc_session");
    if (!sessionId || !sessionStore) return null;

    const session = await sessionStore.get(sessionId);
    if (!session) return null;

    return {
      userId: session.userId,
      authTime: Math.floor(session.createdAt.getTime() / 1000),
    };
  };

  router.get("/", async (c) => {
    const authRequest = parseAuthorizationRequest(c.req.query());

    if ("error" in authRequest) {
      return renderError(c, authRequest.error, authRequest.error_description);
    }

    const client = await stores.clients.get(authRequest.clientId);
    if (!client) {
      return renderError(c, "invalid_client", "Unknown client");
    }

    if (!redirectUriAllowed(client.redirectUris, authRequest.redirectUri)) {
      return renderError(c, "invalid_redirect_uri", "Redirect URI not registered");
    }

    if (authRequest.responseType !== "code") {
      return redirectWithError(
        c,
        authRequest.redirectUri,
        authRequest.state,
        "unsupported_response_type",
        "Only code response type is supported"
      );
    }

    const isPublicClient = client.tokenEndpointAuthMethod === "none";
    const pkceRequired = config.security?.pkce?.required ?? false;

    if ((isPublicClient || pkceRequired) && !authRequest.codeChallenge) {
      return redirectWithError(
        c,
        authRequest.redirectUri,
        authRequest.state,
        "invalid_request",
        isPublicClient
          ? "PKCE is required for public clients"
          : "PKCE is required"
      );
    }

    if (authRequest.codeChallengeMethod === "plain") {
      return redirectWithError(
        c,
        authRequest.redirectUri,
        authRequest.state,
        "invalid_request",
        "code_challenge_method 'plain' is not allowed; use S256"
      );
    }

    if (
      authRequest.codeChallenge &&
      authRequest.codeChallengeMethod &&
      authRequest.codeChallengeMethod !== "S256"
    ) {
      return redirectWithError(
        c,
        authRequest.redirectUri,
        authRequest.state,
        "invalid_request",
        "Only S256 code challenge method is supported"
      );
    }

    const session = await extractSession(c);

    if (authRequest.prompt === "none" && !session) {
      return redirectWithError(
        c,
        authRequest.redirectUri,
        authRequest.state,
        "login_required",
        "User is not authenticated"
      );
    }

    if (authRequest.prompt === "login" || !session) {
      const interactionId = crypto.randomUUID();
      await stores.interactions.set(interactionId, {
        authRequest,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const loginUrl = new URL(config.ui?.loginPath ?? "/login", config.baseUrl ?? config.issuer);
      loginUrl.searchParams.set("interaction", interactionId);
      return c.redirect(loginUrl.toString(), 302);
    }

    const requestedScopes = authRequest.scope.split(" ");
    const existingConsent = await stores.consent.get(session.userId, authRequest.clientId);
    const needsConsent =
      !existingConsent || !requestedScopes.every((s) => existingConsent.scopes.includes(s));

    if (needsConsent && authRequest.prompt !== "consent") {
      if (authRequest.prompt === "none") {
        return redirectWithError(
          c,
          authRequest.redirectUri,
          authRequest.state,
          "consent_required",
          "User consent is required"
        );
      }

      const interactionId = crypto.randomUUID();
      await stores.interactions.set(interactionId, {
        authRequest,
        userId: session.userId,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const consentUrl = new URL(config.ui?.consentPath ?? "/consent", config.baseUrl ?? config.issuer);
      consentUrl.searchParams.set("interaction", interactionId);
      return c.redirect(consentUrl.toString(), 302);
    }

    const code = crypto.randomBytes(32).toString("hex");
    const authCode: AuthorizationCode = {
      code,
      clientId: authRequest.clientId,
      userId: session.userId,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      nonce: authRequest.nonce,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      authTime: session.authTime,
      expiresAt: Date.now() + (config.tokens?.authorizationCode?.ttlSeconds ?? 600) * 1000,
    };

    await stores.authorizationCodes.set(authCode);

    const redirectUrl = new URL(authRequest.redirectUri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", authRequest.state);

    return c.redirect(redirectUrl.toString(), 302);
  });

  return router;
};
