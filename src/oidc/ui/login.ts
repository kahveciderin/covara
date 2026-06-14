import { Hono } from "hono";
import {
  AuthBackend,
  OIDCProviderConfig,
  OIDCProviderStores,
} from "../types";
import { SessionStore } from "@/auth/types";
import { readFormBody } from "../body";
import { escapeHtml } from "../util";
import { finishInteractiveLogin } from "../complete-login";

const defaultLoginTemplate = (
  error?: string,
  loginHint?: string,
  providers?: Array<{ name: string; authUrl: string }>
): string => `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { width: 100%; max-width: 400px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { margin: 0 0 1.5rem; text-align: center; color: #333; }
    .error { background: #fee; border: 1px solid #fcc; color: #c00; padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { font-weight: 500; color: #333; }
    input { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
    input:focus { outline: none; border-color: #007bff; }
    button { padding: 0.75rem; background: #007bff; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #0056b3; }
    .divider { display: flex; align-items: center; margin: 1.5rem 0; color: #666; }
    .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #ddd; }
    .divider span { padding: 0 1rem; }
    .providers { display: flex; flex-direction: column; gap: 0.5rem; }
    .provider { display: block; padding: 0.75rem; text-align: center; border: 1px solid #ddd; border-radius: 4px; text-decoration: none; color: #333; }
    .provider:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sign In</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST">
      <div>
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeHtml(loginHint ?? "")}" required autofocus />
      </div>
      <div>
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required />
      </div>
      <button type="submit">Sign In</button>
    </form>
    ${
      providers && providers.length > 0
        ? `
    <div class="divider"><span>or continue with</span></div>
    <div class="providers">
      ${providers.map((p) => `<a href="${escapeHtml(p.authUrl)}" class="provider">${escapeHtml(p.name)}</a>`).join("")}
    </div>
    `
        : ""
    }
  </div>
</body>
</html>
`;

interface LoginHandlerConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  backends: AuthBackend[];
  sessionStore: SessionStore;
}

export const createLoginHandler = ({
  config,
  stores,
  backends,
  sessionStore,
}: LoginHandlerConfig): Hono => {
  const router = new Hono();

  const emailPasswordBackend = backends.find((b) => b.name === "email-password");
  const externalProviders = backends.flatMap((b) => b.getExternalProviders?.() ?? []);

  router.get("/", async (c) => {
    const interactionId = c.req.query("interaction");

    if (!interactionId) {
      return c.html("Missing interaction parameter", 400);
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction) {
      return c.html("Invalid or expired interaction", 400);
    }

    if (config.ui?.customLoginHandler) {
      return config.ui.customLoginHandler(c, interaction);
    }

    const template =
      config.ui?.templates?.login ??
      defaultLoginTemplate(
        undefined,
        interaction.authRequest.loginHint,
        externalProviders.map((p) => ({
          ...p,
          authUrl: `${p.authUrl}?interaction=${interactionId}`,
        }))
      );

    return c.html(template);
  });

  router.post("/", async (c) => {
    const interactionId = c.req.query("interaction");

    if (!interactionId) {
      return c.html("Missing interaction parameter", 400);
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction) {
      return c.html("Invalid or expired interaction", 400);
    }

    if (!emailPasswordBackend) {
      return c.html("Email/password authentication not configured", 400);
    }

    const result = await emailPasswordBackend.authenticate(c);

    if (!result.success || !result.user) {
      const body = await readFormBody(c);
      const template =
        config.ui?.templates?.login ??
        defaultLoginTemplate(
          result.error ?? "Invalid credentials",
          body.email,
          externalProviders.map((p) => ({
            ...p,
            authUrl: `${p.authUrl}?interaction=${interactionId}`,
          }))
        );
      return c.html(template, 401);
    }

    return finishInteractiveLogin(
      c,
      { config, stores, sessionStore },
      {
        interactionId,
        user: result.user,
        amr: result.amr,
        authTime: result.authTime,
        method: "email-password",
      }
    );
  });

  return router;
};
