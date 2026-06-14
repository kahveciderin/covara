import { type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { AuthBackend, AuthBackendResult, OIDCUser } from "../types";
import type { SocialProvider, SocialAccount } from "@/auth/passport-bridge";
import {
  type SocialStateStore,
  createKvSocialStateStore,
  toPassportRequest,
} from "@/auth/social";
import { hasGlobalKV } from "@/kv/types";

interface PassportBackendDeps {
  providers: SocialProvider[];
  baseUrl: string;
  findUserByAccount: (
    provider: string,
    providerAccountId: string
  ) => Promise<OIDCUser | null>;
  createUser: (account: SocialAccount) => Promise<OIDCUser>;
  linkAccount?: (
    userId: string,
    provider: string,
    providerAccountId: string
  ) => Promise<void>;
  stateStore?: SocialStateStore;
  cookieName?: string;
  ttlMs?: number;
}

// In-memory fallback identical to the one social.ts uses standalone — only
// reached when no global KV is configured.
const createMemoryStateStore = (): SocialStateStore => {
  const entries = new Map<
    string,
    { data: { provider: string; session: Record<string, unknown>; interactionId?: string }; expiresAt: number }
  >();
  return {
    set(id, data, ttlMs) {
      entries.set(id, { data, expiresAt: Date.now() + ttlMs });
    },
    get(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(id);
        return null;
      }
      return entry.data;
    },
    delete(id) {
      entries.delete(id);
    },
  };
};

// An OIDC federated backend that delegates to any Passport.js OAuth2 strategy.
// Mirrors createFederatedBackend's contract (getExternalProviders /
// initiateExternalAuth / handleExternalCallback) but runs the strategy through
// the Passport bridge, so the whole passport-oauth2 catalog can drive an OIDC
// login on Node and Workers.
export const createPassportBackend = (deps: PassportBackendDeps): AuthBackend => {
  const providers = new Map<string, SocialProvider>();
  for (const provider of deps.providers) providers.set(provider.name, provider);

  const stateStore =
    deps.stateStore ??
    (hasGlobalKV()
      ? createKvSocialStateStore(undefined, "covara:oidc:passport:state:")
      : createMemoryStateStore());
  const cookieName = deps.cookieName ?? "covara_oidc_passport_state";
  const ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
  const secure = deps.baseUrl.startsWith("https:");

  return {
    name: "passport",

    async authenticate(): Promise<AuthBackendResult> {
      return {
        success: false,
        error: "Use the external auth routes for passport login",
      };
    },

    getExternalProviders() {
      return deps.providers.map((p) => ({
        name: p.name,
        authUrl: `/auth/passport/${p.name}`,
      }));
    },

    async initiateExternalAuth(providerName: string, c: Context): Promise<Response> {
      const provider = providers.get(providerName);
      if (!provider) {
        return c.json({ error: `Unknown provider: ${providerName}` }, 400);
      }

      const session: Record<string, unknown> = {};
      const outcome = await provider.authenticate(toPassportRequest(c, session));
      if (outcome.kind !== "redirect") {
        return c.json(
          {
            error:
              outcome.kind === "error"
                ? outcome.error.message
                : "Provider did not start the authorization flow",
          },
          400
        );
      }

      const stateId = crypto.randomUUID();
      await stateStore.set(
        stateId,
        {
          provider: providerName,
          session,
          interactionId: c.req.query("interaction"),
        },
        ttlMs
      );
      setCookie(c, cookieName, stateId, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        maxAge: Math.floor(ttlMs / 1000),
      });

      return c.redirect(outcome.url, 302);
    },

    async handleExternalCallback(c: Context): Promise<AuthBackendResult> {
      const stateId = getCookie(c, cookieName);
      if (!stateId) return { success: false, error: "Missing or expired login state" };

      const stored = await stateStore.get(stateId);
      await stateStore.delete(stateId);
      deleteCookie(c, cookieName, { path: "/" });
      if (!stored) return { success: false, error: "Missing or expired login state" };

      const provider = providers.get(stored.provider);
      if (!provider) {
        return { success: false, error: `Unknown provider: ${stored.provider}` };
      }

      const outcome = await provider.authenticate(
        toPassportRequest(c, stored.session)
      );
      if (outcome.kind !== "success") {
        return {
          success: false,
          error:
            outcome.kind === "error"
              ? outcome.error.message
              : "Authentication was not completed",
        };
      }

      const account = provider.toAccount(outcome.user, outcome.info);
      let user = await deps.findUserByAccount(
        account.provider,
        account.providerAccountId
      );
      if (!user) {
        user = await deps.createUser(account);
        if (deps.linkAccount) {
          await deps.linkAccount(user.id, account.provider, account.providerAccountId);
        }
      }

      return {
        success: true,
        user,
        authTime: Math.floor(Date.now() / 1000),
        amr: ["fed"],
        provider: stored.provider,
        interactionId: stored.interactionId,
      };
    },
  };
};
