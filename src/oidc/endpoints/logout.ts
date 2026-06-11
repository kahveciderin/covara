import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import {
  OIDCProviderConfig,
  OIDCProviderStores,
  TokenService,
} from "../types";
import { SessionStore } from "@/auth/types";
import { redirectUriAllowed } from "../util";

interface LogoutEndpointConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  tokenService: TokenService;
  sessionStore?: SessionStore;
}

const defaultLoggedOutTemplate = (): string => `
<!DOCTYPE html>
<html>
<head>
  <title>Logged Out</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { margin: 0 0 1rem; color: #333; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>You have been logged out</h1>
    <p>You can close this window or return to the application.</p>
  </div>
</body>
</html>
`;

export const createLogoutEndpoint = ({
  config,
  stores,
  tokenService,
  sessionStore,
}: LogoutEndpointConfig): Hono => {
  const router = new Hono();

  router.get("/", async (c) => {
    const id_token_hint = c.req.query("id_token_hint");
    const post_logout_redirect_uri = c.req.query("post_logout_redirect_uri");
    const state = c.req.query("state");
    const client_id = c.req.query("client_id");

    let userId: string | undefined;

    if (id_token_hint) {
      try {
        const decoded = await tokenService.decodeIdToken(id_token_hint);
        userId = decoded.sub;
      } catch {
        // Invalid token hint - continue but don't use it
      }
    }

    const sessionId = getCookie(c, "oidc_session");
    if (sessionId && sessionStore) {
      const session = await sessionStore.get(sessionId);
      if (session) {
        userId = userId ?? session.userId;
        await sessionStore.delete(sessionId);
      }
    }

    if (userId) {
      await stores.refreshTokens.deleteByUserId(userId);

      if (config.hooks?.onLogout) {
        await config.hooks.onLogout(userId, sessionId);
      }
    }

    deleteCookie(c, "oidc_session", { path: "/" });

    if (post_logout_redirect_uri) {
      let isValidRedirect = false;

      if (client_id) {
        const client = await stores.clients.get(client_id);
        isValidRedirect = client?.postLogoutRedirectUris
          ? redirectUriAllowed(client.postLogoutRedirectUris, post_logout_redirect_uri)
          : false;
      }

      if (isValidRedirect) {
        const redirectUrl = new URL(post_logout_redirect_uri);
        if (state) {
          redirectUrl.searchParams.set("state", state);
        }
        return c.redirect(redirectUrl.toString(), 302);
      }
    }

    const template = config.ui?.templates?.loggedOut ?? defaultLoggedOutTemplate();
    return c.html(template);
  });

  router.post("/", async (c) => {
    const sessionId = getCookie(c, "oidc_session");
    if (sessionId && sessionStore) {
      const session = await sessionStore.get(sessionId);
      if (session) {
        await sessionStore.delete(sessionId);
        await stores.refreshTokens.deleteByUserId(session.userId);

        if (config.hooks?.onLogout) {
          await config.hooks.onLogout(session.userId, sessionId);
        }
      }
    }

    deleteCookie(c, "oidc_session", { path: "/" });
    return c.json({ success: true });
  });

  return router;
};
