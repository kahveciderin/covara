import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { isProduction } from "@/server/env";
import { hasGlobalKV, getGlobalKV } from "@/kv/types";
import type { SocialAccount, SocialProvider, PassportRequest } from "./passport-bridge";
import type { AuthUser } from "./routes";

// State carried between the authorize redirect and the provider callback. The
// passport strategy stores its CSRF/PKCE handle inside `session`; we persist the
// whole bag keyed by an opaque id held in a short-lived cookie.
interface SocialStateData {
  provider: string;
  session: Record<string, unknown>;
  // Optional pending OIDC interaction to resume after callback (used when the
  // bridge backs the OIDC provider's `backends.passport`).
  interactionId?: string;
}

export interface SocialStateStore {
  set(id: string, data: SocialStateData, ttlMs: number): Promise<void> | void;
  get(id: string): Promise<SocialStateData | null> | (SocialStateData | null);
  delete(id: string): Promise<void> | void;
}

class InMemorySocialStateStore implements SocialStateStore {
  private entries = new Map<string, { data: SocialStateData; expiresAt: number }>();

  set(id: string, data: SocialStateData, ttlMs: number): void {
    this.entries.set(id, { data, expiresAt: Date.now() + ttlMs });
  }

  get(id: string): SocialStateData | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.data;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }
}

// KV-backed store for multi-instance / Workers deployments, where the authorize
// and callback requests may land on different isolates.
export const createKvSocialStateStore = (
  kv = getGlobalKV(),
  prefix = "covara:social:state:"
): SocialStateStore => ({
  async set(id, data, ttlMs) {
    await kv.set(`${prefix}${id}`, JSON.stringify(data), {
      px: ttlMs,
    });
  },
  async get(id) {
    const raw = await kv.get(`${prefix}${id}`);
    return raw ? (JSON.parse(raw) as SocialStateData) : null;
  },
  async delete(id) {
    await kv.del(`${prefix}${id}`);
  },
});

export interface SocialAuthOptions {
  // Providers from `fromPassport(new SomeStrategy(...))`.
  providers: SocialProvider[];
  // Resolve (or create) the app user for an authenticated social account.
  findOrCreateUser: (account: SocialAccount, c: Context) => Promise<AuthUser>;
  // Where the routes mount under the auth router. Default "/social".
  basePath?: string;
  // Where to send the browser after a successful login. Default "/".
  successRedirect?: string;
  // Where to send the browser after a failed login. If omitted, failures return
  // a 401 JSON problem instead of redirecting.
  failureRedirect?: string;
  stateStore?: SocialStateStore;
  stateCookieName?: string;
  stateTtlMs?: number;
}

interface SocialRouterDeps {
  // Mints the session + cookie + CSRF token and fires onLogin — identical to the
  // password-login path.
  completeLogin: (
    c: Context,
    userId: string
  ) => Promise<Record<string, unknown> | null>;
  cookieSecure: boolean;
  cookiePath: string;
}

// Build the synthesized passport `req` from a Hono context.
export const toPassportRequest = (
  c: Context,
  session: Record<string, unknown>
): PassportRequest => {
  const url = new URL(c.req.url);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (!headers.host) headers.host = url.host;
  // originalURL() consults x-forwarded-proto / connection.encrypted for relative
  // callbackURLs; mirror the request's scheme so both relative and absolute work.
  if (!headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = url.protocol.replace(":", "");
  }
  return {
    query: c.req.query() as Record<string, unknown>,
    headers,
    session,
    url: url.pathname + url.search,
    method: c.req.method,
    connection: { encrypted: url.protocol === "https:" },
  };
};

export const createSocialRouter = (
  options: SocialAuthOptions,
  deps: SocialRouterDeps
): Hono => {
  const providers = new Map<string, SocialProvider>();
  for (const provider of options.providers) {
    providers.set(provider.name, provider);
  }

  const stateStore =
    options.stateStore ??
    (hasGlobalKV() ? createKvSocialStateStore() : new InMemorySocialStateStore());
  const stateCookieName = options.stateCookieName ?? "covara_oauth_state";
  const stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000;
  const successRedirect = options.successRedirect ?? "/";

  const router = new Hono();

  const fail = (c: Context, reason: string) => {
    deleteCookie(c, stateCookieName, { path: deps.cookiePath });
    if (options.failureRedirect) {
      return c.redirect(options.failureRedirect);
    }
    return c.json(
      { error: { code: "SOCIAL_AUTH_FAILED", message: reason } },
      401
    );
  };

  // Begin login: redirect the browser to the provider.
  router.get("/:provider", async (c) => {
    const provider = providers.get(c.req.param("provider"));
    if (!provider) {
      return c.json(
        { error: { code: "UNKNOWN_PROVIDER", message: "Unknown social provider" } },
        404
      );
    }

    const session: Record<string, unknown> = {};
    const outcome = await provider.authenticate(toPassportRequest(c, session));

    if (outcome.kind !== "redirect") {
      return fail(
        c,
        outcome.kind === "error"
          ? outcome.error.message
          : "Provider did not start the authorization flow"
      );
    }

    const stateId = crypto.randomUUID();
    await stateStore.set(stateId, { provider: provider.name, session }, stateTtlMs);
    setCookie(c, stateCookieName, stateId, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: "Lax",
      path: deps.cookiePath,
      maxAge: Math.floor(stateTtlMs / 1000),
    });

    return c.redirect(outcome.url);
  });

  // Provider callback: verify state, exchange the code, resolve the user.
  router.get("/:provider/callback", async (c) => {
    const provider = providers.get(c.req.param("provider"));
    if (!provider) {
      return c.json(
        { error: { code: "UNKNOWN_PROVIDER", message: "Unknown social provider" } },
        404
      );
    }

    const stateId = getCookie(c, stateCookieName);
    if (!stateId) return fail(c, "Missing or expired login state");

    const stored = await stateStore.get(stateId);
    await stateStore.delete(stateId);
    if (!stored || stored.provider !== provider.name) {
      return fail(c, "Missing or expired login state");
    }

    const outcome = await provider.authenticate(
      toPassportRequest(c, stored.session)
    );

    if (outcome.kind !== "success") {
      return fail(
        c,
        outcome.kind === "error"
          ? outcome.error.message
          : "Authentication was not completed"
      );
    }

    let authUser: AuthUser;
    try {
      const account = provider.toAccount(outcome.user, outcome.info);
      authUser = await options.findOrCreateUser(account, c);
    } catch (e) {
      return fail(c, e instanceof Error ? e.message : "Could not resolve user");
    }

    const result = await deps.completeLogin(c, authUser.id);
    if (!result) return fail(c, "Could not establish a session");

    deleteCookie(c, stateCookieName, { path: deps.cookiePath });
    return c.redirect(successRedirect);
  });

  return router;
};

export const defaultSocialSecure = (): boolean => isProduction();
