import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import jwt, { type Algorithm, type SignOptions, type VerifyOptions } from "jsonwebtoken";
import {
  AuthAdapter,
  AuthResult,
  SessionData,
  SessionStore,
  InMemorySessionStore,
} from "./types";
import { createUserContext } from "./adapter";
import { UserContext } from "@/resource/types";
import { readJsonBody } from "@/server/request";
import { isProduction } from "@/server/env";

// The user shape a strategy hydrates from a stored reference (session.userId /
// token sub). Matches what `getUserById` returns across the adapters.
export interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  metadata?: Record<string, unknown>;
}

// What a strategy mints for a freshly authenticated user. The artifacts present
// depend on the strategy (a cookie session yields `sessionId`; JWT yields tokens).
export interface IssuedSession {
  user: UserContext;
  sessionId?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: Date;
}

// How an authenticated identity is persisted, validated per request, and issued
// at login — fully independent of *how the user was authenticated* (password,
// Passport social, OIDC, …). Pick `cookieSession` or `jwtSession` (or bring your
// own) and compose it with any credential provider in `useAuth`.
export interface SessionStrategy {
  name: string;
  // Validate an incoming request → user (auth middleware + `/me`).
  authenticate(c: Context): Promise<AuthResult>;
  // Mint + transmit a session/token for `userId` (resolved via getUserById).
  issue(
    c: Context,
    userId: string,
    meta?: Record<string, unknown>
  ): Promise<IssuedSession>;
  // Clear/revoke the current request's session/token.
  logout(c: Context): Promise<void>;
  invalidateUserSessions?(userId: string, exceptSessionId?: string): Promise<void>;
  // Strategy-owned routes mounted under the auth router (e.g. JWT `/refresh`).
  getRoutes?(): Hono;
  // Exposed for the admin session manager (cookie strategy only).
  readonly sessionStore?: SessionStore;
}

const ACTIVITY_THROTTLE_MS = 60_000;

export interface CookieSessionOptions {
  getUserById: (id: string) => Promise<SessionUser | null>;
  store?: SessionStore;
  cookieName?: string;
  cookieOptions?: Omit<CookieOptions, "expires">;
  ttlMs?: number;
  getUserContext?: (user: SessionUser, session: SessionData) => UserContext;
}

// Server-side sessions: an opaque id in an httpOnly cookie, backed by a
// SessionStore (memory / KV / Drizzle). Rotates on login; revocable.
export const cookieSession = (options: CookieSessionOptions): SessionStrategy => {
  const store = options.store ?? new InMemorySessionStore();
  const cookieName = options.cookieName ?? "session";
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const cookieOptions: Omit<CookieOptions, "expires"> = {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "Lax",
    path: "/",
    ...options.cookieOptions,
  };
  const toContext = (user: SessionUser, session: SessionData): UserContext =>
    options.getUserContext
      ? options.getUserContext(user, session)
      : createUserContext(user, session);

  const readSession = async (sessionId: string): Promise<SessionData | null> => {
    const session = await store.get(sessionId);
    if (session) {
      const now = Date.now();
      const last =
        typeof session.data?.lastActiveAt === "number" ? session.data.lastActiveAt : 0;
      const remaining = session.expiresAt.getTime() - now;
      if (now - last >= ACTIVITY_THROTTLE_MS && remaining > 0) {
        session.data = { ...session.data, lastActiveAt: now };
        void store.set(session.id, session, remaining).catch(() => {});
      }
    }
    return session;
  };

  const createSession = async (
    userId: string,
    data?: Record<string, unknown>
  ): Promise<SessionData> => {
    const session: SessionData = {
      id: crypto.randomUUID(),
      userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
      data,
    };
    await store.set(session.id, session, ttlMs);
    return session;
  };

  return {
    name: "cookie",
    sessionStore: store,

    async authenticate(c) {
      const sessionId = getCookie(c, cookieName);
      if (!sessionId) return { success: false, error: "No session" };
      const session = await readSession(sessionId);
      if (!session) return { success: false, error: "Session not found or expired" };
      const user = await options.getUserById(session.userId);
      if (!user) return { success: false, error: "User not found" };
      return {
        success: true,
        user: toContext(user, session),
        expiresAt: session.expiresAt,
      };
    },

    async issue(c, userId, meta) {
      // Rotate: drop any prior session this cookie referenced.
      const prior = getCookie(c, cookieName);
      if (prior) await store.delete(prior);

      const session = await createSession(userId, meta);
      const user = await options.getUserById(userId);
      if (!user) throw new Error("Cannot issue a session for an unknown user");

      setCookie(c, cookieName, session.id, {
        ...cookieOptions,
        expires: session.expiresAt,
      });

      return {
        user: toContext(user, session),
        sessionId: session.id,
        expiresAt: session.expiresAt,
      };
    },

    async logout(c) {
      const sessionId = getCookie(c, cookieName);
      if (sessionId) await store.delete(sessionId);
      deleteCookie(c, cookieName, { path: cookieOptions.path });
    },

    async invalidateUserSessions(userId, exceptSessionId) {
      if (!exceptSessionId && store.deleteByUser) {
        await store.deleteByUser(userId);
        return;
      }
      const all = store.getByUser
        ? await store.getByUser(userId)
        : ((await store.getAll?.()) ?? []).filter((s) => s.userId === userId);
      await Promise.all(
        all.filter((s) => s.id !== exceptSessionId).map((s) => store.delete(s.id))
      );
    },
  };
};

interface JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  image?: string;
  emailVerified?: boolean;
  metadata?: Record<string, unknown>;
  iat?: number;
  exp?: number;
  jti?: string;
}

export interface JwtSessionOptions {
  getUserById: (id: string) => Promise<SessionUser | null>;
  secret: string | Buffer;
  publicKey?: string | Buffer;
  algorithm?: Algorithm;
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  issuer?: string;
  audience?: string | string[];
  clockTolerance?: number;
  refreshStore?: SessionStore;
  refreshCookieName?: string;
  getUserContext?: (user: SessionUser, payload: JWTPayload) => UserContext;
}

// Stateless JWT access tokens + (optionally store-backed, revocable) refresh
// tokens. Issued on login, validated from the `Authorization: Bearer` header.
export const jwtSession = (options: JwtSessionOptions): SessionStrategy => {
  const algorithm = options.algorithm ?? "HS256";
  const accessTokenTtl = options.accessTokenTtl ?? 15 * 60;
  const refreshTokenTtl = options.refreshTokenTtl ?? 7 * 24 * 60 * 60;
  const clockTolerance = options.clockTolerance ?? 30;
  const refreshCookieName = options.refreshCookieName ?? "refreshToken";
  const refreshStore = options.refreshStore;

  const toContext = (payload: JWTPayload): UserContext => {
    const user: SessionUser = {
      id: payload.sub,
      email: payload.email ?? null,
      name: payload.name ?? null,
      image: payload.image ?? null,
      emailVerified: payload.emailVerified ? new Date() : null,
      metadata: payload.metadata,
    };
    if (options.getUserContext) return options.getUserContext(user, payload);
    return {
      id: payload.sub,
      email: user.email ?? null,
      name: user.name ?? null,
      image: user.image ?? null,
      emailVerified: user.emailVerified ?? null,
      sessionId: payload.jti ?? `jwt:${payload.sub}`,
      sessionExpiresAt: payload.exp
        ? new Date(payload.exp * 1000)
        : new Date(Date.now() + accessTokenTtl * 1000),
      metadata: payload.metadata,
    };
  };

  const signTokens = (user: SessionUser) => {
    const jti = crypto.randomUUID();
    const signOptions: SignOptions = { algorithm, expiresIn: accessTokenTtl };
    if (options.issuer) signOptions.issuer = options.issuer;
    if (options.audience) signOptions.audience = options.audience;

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email ?? undefined,
        name: user.name ?? undefined,
        image: user.image ?? undefined,
        emailVerified: !!user.emailVerified,
        metadata: user.metadata,
        jti,
      } satisfies JWTPayload,
      options.secret,
      signOptions
    );
    const refreshToken = jwt.sign(
      { sub: user.id, jti: `refresh:${jti}` } satisfies JWTPayload,
      options.secret,
      { ...signOptions, expiresIn: refreshTokenTtl }
    );
    return { accessToken, refreshToken, jti };
  };

  const verify = (token: string): JWTPayload => {
    const verifyOptions: VerifyOptions = { algorithms: [algorithm], clockTolerance };
    if (options.issuer) verifyOptions.issuer = options.issuer;
    if (options.audience) {
      verifyOptions.audience = Array.isArray(options.audience)
        ? options.audience[0]
        : options.audience;
    }
    return jwt.verify(token, options.publicKey ?? options.secret, verifyOptions) as JWTPayload;
  };

  const storeRefresh = async (jti: string, userId: string) => {
    if (!refreshStore) return;
    const key = `refresh:${jti}`;
    await refreshStore.set(
      key,
      {
        id: key,
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + refreshTokenTtl * 1000),
      },
      refreshTokenTtl * 1000
    );
  };

  const setRefreshCookie = (c: Context, refreshToken: string) => {
    setCookie(c, refreshCookieName, refreshToken, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "Strict",
      maxAge: refreshTokenTtl,
      path: "/",
    });
  };

  const issueFor = async (c: Context, user: SessionUser): Promise<IssuedSession> => {
    const { accessToken, refreshToken, jti } = signTokens(user);
    await storeRefresh(jti, user.id);
    setRefreshCookie(c, refreshToken);
    return {
      user: toContext(jwt.decode(accessToken) as JWTPayload),
      accessToken,
      refreshToken,
      expiresIn: accessTokenTtl,
      expiresAt: new Date(Date.now() + accessTokenTtl * 1000),
    };
  };

  return {
    name: "jwt",

    async authenticate(c) {
      const header = c.req.header("authorization");
      if (!header?.startsWith("Bearer ")) return { success: false, error: "No token" };
      try {
        const payload = verify(header.slice(7));
        return {
          success: true,
          user: toContext(payload),
          expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
        };
      } catch (e) {
        if (e instanceof jwt.TokenExpiredError) return { success: false, error: "Token expired" };
        return { success: false, error: "Invalid token" };
      }
    },

    async issue(c, userId, _meta) {
      const user = await options.getUserById(userId);
      if (!user) throw new Error("Cannot issue tokens for an unknown user");
      return issueFor(c, user);
    },

    async logout(c) {
      const refreshToken = getCookie(c, refreshCookieName);
      if (refreshToken && refreshStore) {
        try {
          const payload = jwt.decode(refreshToken) as JWTPayload | null;
          if (payload?.jti) await refreshStore.delete(payload.jti);
        } catch {
          // ignore
        }
      }
      deleteCookie(c, refreshCookieName, { path: "/" });
    },

    getRoutes() {
      const router = new Hono();
      router.post("/refresh", async (c) => {
        const body = (await readJsonBody(c).catch(() => ({}))) as { refreshToken?: string };
        const refreshToken = getCookie(c, refreshCookieName) ?? body?.refreshToken;
        if (!refreshToken) {
          return c.json({ error: { code: "NO_REFRESH_TOKEN", message: "Refresh token required" } }, 400);
        }
        try {
          const payload = verify(refreshToken);
          if (refreshStore) {
            const stored = await refreshStore.get(payload.jti!);
            if (!stored) {
              return c.json({ error: { code: "TOKEN_REVOKED", message: "Refresh token revoked" } }, 401);
            }
            await refreshStore.delete(payload.jti!);
          }
          const user = await options.getUserById(payload.sub);
          if (!user) {
            return c.json({ error: { code: "USER_NOT_FOUND", message: "User not found" } }, 401);
          }
          const issued = await issueFor(c, user);
          return c.json({
            accessToken: issued.accessToken,
            expiresIn: issued.expiresIn,
            tokenType: "Bearer",
          });
        } catch (e) {
          const expired = e instanceof jwt.TokenExpiredError;
          return c.json(
            {
              error: {
                code: expired ? "REFRESH_TOKEN_EXPIRED" : "INVALID_REFRESH_TOKEN",
                message: expired ? "Refresh token expired" : "Invalid refresh token",
              },
            },
            401
          );
        }
      });
      return router;
    },
  };
};

// Back-compat: wrap a legacy AuthAdapter (createPassportAdapter, etc.) into a
// SessionStrategy so `useAuth({ adapter })` keeps its exact behavior. The cookie
// config comes from useAuth so issuance matches the pre-strategy code path.
export const fromAuthAdapter = (
  adapter: AuthAdapter,
  cookie: { name: string; options: Omit<CookieOptions, "expires"> }
): SessionStrategy => ({
  name: adapter.name,
  sessionStore: (adapter as { sessionStore?: SessionStore }).sessionStore,

  async authenticate(c) {
    const credentials = adapter.extractCredentials(c);
    if (!credentials) return { success: false, error: "No credentials" };
    return adapter.validateCredentials(credentials);
  },

  async issue(c, userId, meta) {
    if (!adapter.createSession) {
      throw new Error("Adapter does not support session creation");
    }
    const prior = getCookie(c, cookie.name);
    if (prior) await adapter.invalidateSession(prior);

    const session = await adapter.createSession(userId, meta);
    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });
    if (!result.success || !result.user) {
      throw new Error("Failed to establish a session");
    }
    setCookie(c, cookie.name, session.id, {
      ...cookie.options,
      expires: session.expiresAt,
    });
    return { user: result.user, sessionId: session.id, expiresAt: session.expiresAt };
  },

  async logout(c) {
    const credentials = adapter.extractCredentials(c);
    const token = credentials?.sessionId ?? credentials?.token;
    if (token) await adapter.invalidateSession(token);
    deleteCookie(c, cookie.name);
    deleteCookie(c, "connect.sid");
    deleteCookie(c, "session");
  },

  invalidateUserSessions: adapter.invalidateUserSessions
    ? (userId, exceptSessionId) => adapter.invalidateUserSessions!(userId, exceptSessionId)
    : undefined,
});
