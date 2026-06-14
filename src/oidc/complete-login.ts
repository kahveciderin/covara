import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import * as crypto from "node:crypto";
import {
  AuthBackend,
  AuthorizationCode,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
} from "./types";
import { SessionStore } from "@/auth/types";
import { isProduction } from "@/server/env";
import { escapeHtml } from "./util";

export interface CompleteLoginDeps {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  sessionStore: SessionStore;
}

export interface CompleteLoginParams {
  interactionId: string;
  user: OIDCUser;
  amr?: string[];
  authTime?: number;
  // Identifier passed to the onUserAuthenticated hook (e.g. "email-password",
  // "github").
  method?: string;
}

// Resume a pending OIDC authorization interaction once a user is authenticated:
// establish the provider session + cookie, drop the interaction, then continue
// to consent (when required) or straight to the authorization-code redirect.
// Shared by the email/password login form and every external (federated /
// Passport) callback so they complete identically.
export const finishInteractiveLogin = async (
  c: Context,
  deps: CompleteLoginDeps,
  params: CompleteLoginParams
): Promise<Response> => {
  const { config, stores, sessionStore } = deps;
  const interaction = await stores.interactions.get(params.interactionId);
  if (!interaction) {
    return c.html("Invalid or expired interaction", 400);
  }

  const sessionId = crypto.randomUUID();
  await sessionStore.set(
    sessionId,
    {
      id: sessionId,
      userId: params.user.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      data: { amr: params.amr },
    },
    24 * 60 * 60 * 1000
  );

  setCookie(c, "oidc_session", sessionId, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    maxAge: 24 * 60 * 60,
    path: "/",
  });

  if (config.hooks?.onUserAuthenticated) {
    await config.hooks.onUserAuthenticated(
      params.user,
      params.method ?? "external"
    );
  }

  await stores.interactions.delete(params.interactionId);

  const authRequest = interaction.authRequest;
  const requestedScopes = authRequest.scope.split(" ");
  const existingConsent = await stores.consent.get(
    params.user.id,
    authRequest.clientId
  );
  const needsConsent =
    !existingConsent ||
    !requestedScopes.every((s) => existingConsent.scopes.includes(s));

  if (needsConsent) {
    const newInteractionId = crypto.randomUUID();
    await stores.interactions.set(newInteractionId, {
      authRequest,
      userId: params.user.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const consentUrl = new URL(
      config.ui?.consentPath ?? "/consent",
      config.baseUrl ?? config.issuer
    );
    consentUrl.searchParams.set("interaction", newInteractionId);
    return c.redirect(consentUrl.toString(), 302);
  }

  const code = crypto.randomBytes(32).toString("hex");
  const authCode: AuthorizationCode = {
    code,
    clientId: authRequest.clientId,
    userId: params.user.id,
    redirectUri: authRequest.redirectUri,
    scope: authRequest.scope,
    nonce: authRequest.nonce,
    codeChallenge: authRequest.codeChallenge,
    codeChallengeMethod: authRequest.codeChallengeMethod,
    authTime: params.authTime ?? Math.floor(Date.now() / 1000),
    expiresAt:
      Date.now() + (config.tokens?.authorizationCode?.ttlSeconds ?? 600) * 1000,
  };

  await stores.authorizationCodes.set(authCode);

  const redirectUrl = new URL(authRequest.redirectUri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", authRequest.state);

  return c.redirect(redirectUrl.toString(), 302);
};

// Mount the redirect + callback routes for an external (federated / Passport)
// backend so a successful callback resumes the OIDC interaction. This is what
// turns "authenticated against the upstream provider" into "issued an auth code
// for the relying party".
export const createExternalAuthRoutes = (
  backend: AuthBackend,
  deps: CompleteLoginDeps
): Hono => {
  const router = new Hono();

  router.get("/callback", async (c) => {
    const result = await backend.handleExternalCallback!(c);

    if (!result.success || !result.user) {
      return c.html(
        `<p>Login failed: ${escapeHtml(result.error ?? "unknown error")}</p>`,
        400
      );
    }

    if (!result.interactionId) {
      // No pending interaction (e.g. invoked outside an /authorize flow).
      return c.json({ success: true, user: result.user });
    }

    return finishInteractiveLogin(c, deps, {
      interactionId: result.interactionId,
      user: result.user,
      amr: result.amr,
      authTime: result.authTime,
      method: result.provider,
    });
  });

  router.get("/:provider", async (c) => {
    return backend.initiateExternalAuth!(c.req.param("provider"), c);
  });

  return router;
};
