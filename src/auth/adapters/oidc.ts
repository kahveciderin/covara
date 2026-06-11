import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { BaseAuthAdapter, createUserContext } from "../adapter";
import {
  AuthCredentials,
  AuthResult,
  SessionData,
  SessionStore,
} from "../types";
import { UserContext } from "@/resource/types";
import { isProduction } from "@/server/env";
import * as crypto from "node:crypto";

export interface OIDCProviderConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  scopes?: string[];
  redirectUri?: string;
  responseType?: "code" | "id_token" | "code id_token";
  pkce?: boolean;
  audience?: string;
  clockTolerance?: number;
}

interface OIDCDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  response_types_supported: string[];
  scopes_supported: string[];
  claims_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

interface OIDCTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface OIDCUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

export interface OIDCAccount {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  scope?: string;
  idToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OIDCUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface OIDCAdapterOptions {
  providers: OIDCProviderConfig[];
  baseUrl: string;
  callbackPath?: string;
  findUserByAccount?: (
    provider: string,
    providerAccountId: string
  ) => Promise<OIDCUser | null>;
  createUser?: (userInfo: OIDCUserInfo, provider: string) => Promise<OIDCUser>;
  linkAccount?: (
    userId: string,
    account: Omit<OIDCAccount, "id" | "createdAt" | "updatedAt">
  ) => Promise<void>;
  updateAccount?: (
    accountId: string,
    tokens: Partial<OIDCAccount>
  ) => Promise<void>;
  sessionStore?: SessionStore;
  sessionTtlMs?: number;
  getUserContext?: (user: OIDCUser, session: SessionData) => UserContext;
  onSignIn?: (
    user: UserContext,
    account: OIDCAccount,
    isNewUser: boolean
  ) => void | Promise<void>;
  onLinkAccount?: (
    user: UserContext,
    account: OIDCAccount
  ) => void | Promise<void>;
  onError?: (error: Error, provider: string) => void;
}

interface OIDCState {
  provider: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo?: string;
  createdAt: number;
}

export class OIDCAdapter extends BaseAuthAdapter {
  name = "oidc";
  private providers: Map<
    string,
    OIDCProviderConfig & { discovery?: OIDCDiscoveryDocument }
  >;
  private options: OIDCAdapterOptions;
  private stateStore: Map<string, OIDCState> = new Map();
  private discoveryCache: Map<string, OIDCDiscoveryDocument> = new Map();

  constructor(options: OIDCAdapterOptions) {
    super({
      sessionStore: options.sessionStore,
      sessionTtlMs: options.sessionTtlMs,
    });
    this.options = options;
    this.providers = new Map(options.providers.map((p) => [p.name, p]));
  }

  private async discoverProvider(
    provider: OIDCProviderConfig
  ): Promise<OIDCDiscoveryDocument> {
    const cached = this.discoveryCache.get(provider.issuer);
    if (cached) return cached;

    const discoveryUrl = `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch OIDC discovery document from ${discoveryUrl}`
      );
    }

    const doc = (await response.json()) as OIDCDiscoveryDocument;
    this.discoveryCache.set(provider.issuer, doc);
    return doc;
  }

  async getAuthorizationUrl(
    providerName: string,
    returnTo?: string
  ): Promise<string> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    const discovery = await this.discoverProvider(provider);

    const state = crypto.randomUUID();
    const stateData: OIDCState = {
      provider: providerName,
      returnTo,
      createdAt: Date.now(),
    };

    let codeChallenge: string | undefined;
    if (provider.pkce !== false) {
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      stateData.codeVerifier = codeVerifier;
      codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
    }

    stateData.nonce = crypto.randomUUID();
    this.stateStore.set(state, stateData);

    const authUrl = new URL(
      provider.authorizationEndpoint ?? discovery.authorization_endpoint
    );
    const redirectUri =
      provider.redirectUri ??
      `${this.options.baseUrl}${this.options.callbackPath ?? "/auth/oidc/callback"}/${providerName}`;

    authUrl.searchParams.set("client_id", provider.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", provider.responseType ?? "code");
    authUrl.searchParams.set(
      "scope",
      (provider.scopes ?? ["openid", "profile", "email"]).join(" ")
    );
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", stateData.nonce);

    if (codeChallenge) {
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
    }

    return authUrl.toString();
  }

  async handleCallback(
    providerName: string,
    code: string,
    state: string
  ): Promise<{ user: UserContext; session: SessionData; isNewUser: boolean }> {
    const stateData = this.stateStore.get(state);
    if (!stateData || stateData.provider !== providerName) {
      throw new Error("Invalid state parameter");
    }

    if (Date.now() - stateData.createdAt > 10 * 60 * 1000) {
      this.stateStore.delete(state);
      throw new Error("State expired");
    }

    this.stateStore.delete(state);

    const provider = this.providers.get(providerName)!;
    const discovery = await this.discoverProvider(provider);

    const tokenUrl = provider.tokenEndpoint ?? discovery.token_endpoint;
    const redirectUri =
      provider.redirectUri ??
      `${this.options.baseUrl}${this.options.callbackPath ?? "/auth/oidc/callback"}/${providerName}`;

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    });

    if (stateData.codeVerifier) {
      tokenParams.set("code_verifier", stateData.codeVerifier);
    }

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
    }

    const tokens = (await tokenResponse.json()) as OIDCTokenResponse;

    const userInfoUrl = provider.userinfoEndpoint ?? discovery.userinfo_endpoint;
    if (!userInfoUrl) {
      throw new Error("No userinfo endpoint available");
    }

    const userInfoResponse = await fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      throw new Error("Failed to fetch user info");
    }

    const userInfo = (await userInfoResponse.json()) as OIDCUserInfo;

    let user = await this.options.findUserByAccount?.(
      providerName,
      userInfo.sub
    );
    let isNewUser = false;

    if (!user) {
      if (this.options.createUser) {
        user = await this.options.createUser(userInfo, providerName);
        isNewUser = true;
      } else {
        throw new Error("User not found and auto-creation is disabled");
      }
    }

    const accountData: Omit<OIDCAccount, "id" | "createdAt" | "updatedAt"> = {
      userId: user.id,
      provider: providerName,
      providerAccountId: userInfo.sub,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined,
      idToken: tokens.id_token,
      scope: tokens.scope,
    };

    if (isNewUser) {
      await this.options.linkAccount?.(user.id, accountData);
    }

    const session = await this.createSession(user.id, { provider: providerName });

    const userContext = this.options.getUserContext
      ? this.options.getUserContext(user, session)
      : createUserContext(user, session);

    await this.options.onSignIn?.(
      userContext,
      accountData as OIDCAccount,
      isNewUser
    );

    return { user: userContext, session, isNewUser };
  }

  extractCredentials(c: Context): AuthCredentials | null {
    const sessionCookie = getCookie(c, "session");
    if (sessionCookie) {
      return { type: "session", sessionId: sessionCookie };
    }

    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    const token = credentials.sessionId ?? credentials.token;
    if (!token) {
      return { success: false, error: "No token provided" };
    }

    const session = await this.getSession(token);
    if (!session) {
      return { success: false, error: "Session not found or expired" };
    }

    return { success: true, expiresAt: session.expiresAt };
  }

  getRoutes(): Hono {
    const router = new Hono();

    router.get("/provider/:name", async (c) => {
      const name = c.req.param("name");
      try {
        const returnTo = c.req.query("returnTo");
        const authUrl = await this.getAuthorizationUrl(name, returnTo);
        return c.redirect(authUrl, 302);
      } catch (error) {
        this.options.onError?.(error as Error, name);
        return c.json({ error: "Failed to initiate OAuth flow" }, 400);
      }
    });

    router.get("/callback/:name", async (c) => {
      const name = c.req.param("name");
      try {
        const code = c.req.query("code");
        const state = c.req.query("state");
        const error = c.req.query("error");
        const errorDescription = c.req.query("error_description");

        if (error) {
          throw new Error(`OAuth error: ${error} - ${errorDescription}`);
        }

        if (!code || !state) {
          throw new Error("Missing code or state parameter");
        }

        const result = await this.handleCallback(name, code, state);

        setCookie(c, "session", result.session.id, {
          httpOnly: true,
          secure: isProduction(),
          sameSite: "lax",
          expires: result.session.expiresAt,
        });

        const stateData = this.stateStore.get(state);
        const returnTo = stateData?.returnTo ?? "/";
        return c.redirect(returnTo, 302);
      } catch (error) {
        this.options.onError?.(error as Error, name);
        return c.json({ error: "OAuth callback failed" }, 400);
      }
    });

    router.get("/providers", (c) => {
      const providers = Array.from(this.providers.keys()).map((name) => ({
        name,
        authUrl: `/auth/oidc/provider/${name}`,
      }));
      return c.json({ providers });
    });

    router.get("/me", async (c) => {
      const credentials = this.extractCredentials(c);
      if (!credentials) {
        return c.json({ user: null });
      }

      const result = await this.validateCredentials(credentials);
      if (!result.success) {
        return c.json({ user: null });
      }

      return c.json({ expiresAt: result.expiresAt });
    });

    router.post("/logout", async (c) => {
      const credentials = this.extractCredentials(c);
      if (credentials?.sessionId) {
        await this.invalidateSession(credentials.sessionId);
      }

      deleteCookie(c, "session");
      return c.json({ success: true });
    });

    return router;
  }
}

export const createOIDCAdapter = (options: OIDCAdapterOptions): OIDCAdapter => {
  return new OIDCAdapter(options);
};

export const oidcProviders = {
  google: (
    config: Partial<OIDCProviderConfig> & {
      clientId: string;
      clientSecret: string;
    }
  ): OIDCProviderConfig => ({
    name: "google",
    issuer: "https://accounts.google.com",
    scopes: ["openid", "profile", "email"],
    ...config,
  }),

  microsoft: (
    config: Partial<OIDCProviderConfig> & {
      clientId: string;
      clientSecret: string;
      tenantId?: string;
    }
  ): OIDCProviderConfig => ({
    name: "microsoft",
    issuer: `https://login.microsoftonline.com/${config.tenantId ?? "common"}/v2.0`,
    scopes: ["openid", "profile", "email"],
    ...config,
  }),

  okta: (
    config: Partial<OIDCProviderConfig> & {
      clientId: string;
      clientSecret: string;
      domain: string;
    }
  ): OIDCProviderConfig => ({
    name: "okta",
    issuer: `https://${config.domain}`,
    scopes: ["openid", "profile", "email"],
    ...config,
  }),

  auth0: (
    config: Partial<OIDCProviderConfig> & {
      clientId: string;
      clientSecret: string;
      domain: string;
    }
  ): OIDCProviderConfig => ({
    name: "auth0",
    issuer: `https://${config.domain}`,
    scopes: ["openid", "profile", "email"],
    ...config,
  }),

  keycloak: (
    config: Partial<OIDCProviderConfig> & {
      clientId: string;
      clientSecret: string;
      baseUrl: string;
      realm: string;
    }
  ): OIDCProviderConfig => ({
    name: "keycloak",
    issuer: `${config.baseUrl}/realms/${config.realm}`,
    scopes: ["openid", "profile", "email"],
    ...config,
  }),

  generic: (
    config: Partial<OIDCProviderConfig> & {
      name: string;
      clientId: string;
      clientSecret: string;
      issuer: string;
    }
  ): OIDCProviderConfig => ({
    scopes: ["openid", "profile", "email"],
    pkce: true,
    ...config,
  }),
};
