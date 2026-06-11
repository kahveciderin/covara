import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import jwt, { SignOptions, VerifyOptions, Algorithm } from "jsonwebtoken";
import { BaseAuthAdapter } from "../adapter";
import {
  AuthCredentials,
  AuthResult,
  SessionData,
  SessionStore,
} from "../types";
import { UserContext } from "@/resource/types";
import { readJsonBody } from "@/server/request";
import { isProduction } from "@/server/env";

export interface JWTPayload {
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

export interface JWTConfig {
  secret: string | Buffer;
  publicKey?: string | Buffer;
  algorithm?: Algorithm;
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  issuer?: string;
  audience?: string | string[];
  clockTolerance?: number;
}

export interface JWTUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface JWTAdapterOptions {
  jwt: JWTConfig;
  getUserById: (id: string) => Promise<JWTUser | null>;
  validatePassword?: (email: string, password: string) => Promise<JWTUser | null>;
  createUser?: (data: { email: string; password: string; name?: string }) => Promise<JWTUser>;
  refreshTokenStore?: SessionStore;
  getUserContext?: (user: JWTUser, payload: JWTPayload) => UserContext;
  onTokenRefresh?: (
    userId: string,
    oldJti: string,
    newJti: string
  ) => Promise<void>;
}

interface JWTRequestBody {
  email?: string;
  password?: string;
  name?: string;
  refreshToken?: string;
}

export class JWTAdapter extends BaseAuthAdapter {
  name = "jwt";
  private jwtConfig: Required<
    Pick<JWTConfig, "algorithm" | "accessTokenTtl" | "refreshTokenTtl" | "clockTolerance">
  > &
    JWTConfig;
  private getUserByIdFn: JWTAdapterOptions["getUserById"];
  private validatePasswordFn?: JWTAdapterOptions["validatePassword"];
  private createUserFn?: JWTAdapterOptions["createUser"];
  private refreshStore?: SessionStore;
  private getUserContextFn?: JWTAdapterOptions["getUserContext"];
  private onTokenRefreshFn?: JWTAdapterOptions["onTokenRefresh"];

  constructor(options: JWTAdapterOptions) {
    super({ sessionStore: options.refreshTokenStore });
    this.jwtConfig = {
      algorithm: "HS256",
      accessTokenTtl: 15 * 60,
      refreshTokenTtl: 7 * 24 * 60 * 60,
      clockTolerance: 30,
      ...options.jwt,
    };
    this.getUserByIdFn = options.getUserById;
    this.validatePasswordFn = options.validatePassword;
    this.createUserFn = options.createUser;
    this.refreshStore = options.refreshTokenStore;
    this.getUserContextFn = options.getUserContext;
    this.onTokenRefreshFn = options.onTokenRefresh;
  }

  extractCredentials(c: Context): AuthCredentials | null {
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    const refreshToken = getCookie(c, "refreshToken");
    if (refreshToken && c.req.path.endsWith("/refresh")) {
      return { type: "bearer", token: refreshToken };
    }

    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    if (credentials.type !== "bearer" || !credentials.token) {
      return { success: false, error: "Invalid credential type" };
    }

    try {
      const verifyOptions: VerifyOptions = {
        algorithms: [this.jwtConfig.algorithm],
        clockTolerance: this.jwtConfig.clockTolerance,
      };

      if (this.jwtConfig.issuer) verifyOptions.issuer = this.jwtConfig.issuer;
      if (this.jwtConfig.audience) {
        verifyOptions.audience = Array.isArray(this.jwtConfig.audience)
          ? this.jwtConfig.audience[0]
          : this.jwtConfig.audience;
      }

      const key = this.jwtConfig.publicKey ?? this.jwtConfig.secret;
      const payload = jwt.verify(
        credentials.token,
        key,
        verifyOptions
      ) as JWTPayload;

      const userContext = this.createContextFromPayload(payload);

      return {
        success: true,
        user: userContext,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { success: false, error: "Token expired" };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return { success: false, error: "Invalid token" };
      }
      return { success: false, error: "Token validation failed" };
    }
  }

  private createContextFromPayload(payload: JWTPayload): UserContext {
    if (this.getUserContextFn) {
      return this.getUserContextFn(
        {
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          image: payload.image,
          emailVerified: payload.emailVerified ? new Date() : null,
          metadata: payload.metadata,
        },
        payload
      );
    }

    return {
      id: payload.sub,
      email: payload.email ?? null,
      name: payload.name ?? null,
      image: payload.image ?? null,
      emailVerified: payload.emailVerified ? new Date() : null,
      sessionId: payload.jti ?? `jwt:${payload.sub}`,
      sessionExpiresAt: payload.exp
        ? new Date(payload.exp * 1000)
        : new Date(Date.now() + 3600000),
      metadata: payload.metadata,
    };
  }

  private generateTokens(user: JWTUser): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    const jti = crypto.randomUUID();

    const accessPayload: JWTPayload = {
      sub: user.id,
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      image: user.image ?? undefined,
      emailVerified: user.emailVerified ? true : false,
      metadata: user.metadata,
      jti,
    };

    const signOptions: SignOptions = {
      algorithm: this.jwtConfig.algorithm,
      expiresIn: this.jwtConfig.accessTokenTtl,
    };

    if (this.jwtConfig.issuer) signOptions.issuer = this.jwtConfig.issuer;
    if (this.jwtConfig.audience) signOptions.audience = this.jwtConfig.audience;

    const accessToken = jwt.sign(
      accessPayload,
      this.jwtConfig.secret,
      signOptions
    );

    const refreshPayload: JWTPayload = {
      sub: user.id,
      jti: `refresh:${jti}`,
    };

    const refreshToken = jwt.sign(refreshPayload, this.jwtConfig.secret, {
      ...signOptions,
      expiresIn: this.jwtConfig.refreshTokenTtl,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.jwtConfig.accessTokenTtl,
    };
  }

  async getSession(token: string): Promise<SessionData | null> {
    if (!this.refreshStore) return null;

    try {
      const payload = jwt.decode(token) as JWTPayload | null;
      if (!payload?.jti) return null;

      const stored = await this.refreshStore.get(payload.jti);
      return stored;
    } catch {
      return null;
    }
  }

  async invalidateSession(token: string): Promise<void> {
    if (!this.refreshStore) return;

    try {
      const payload = jwt.decode(token) as JWTPayload | null;
      if (payload?.jti) {
        await this.refreshStore.delete(payload.jti);
      }
    } catch {
      // Ignore decode errors on logout
    }
  }

  get middleware(): MiddlewareHandler {
    return async (c, next) => {
      try {
        const credentials = this.extractCredentials(c);
        if (!credentials) {
          return next();
        }

        const result = await this.validateCredentials(credentials);
        if (!result.success || !result.user) {
          return next();
        }

        c.set("user", result.user);
        return next();
      } catch {
        return next();
      }
    };
  }

  private setRefreshCookie(c: Context, refreshToken: string): void {
    setCookie(c, "refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "strict",
      maxAge: this.jwtConfig.refreshTokenTtl,
      path: "/",
    });
  }

  private async storeRefreshSession(accessToken: string, userId: string): Promise<void> {
    if (!this.refreshStore) return;
    const decoded = jwt.decode(accessToken) as JWTPayload;
    const jti = `refresh:${decoded.jti}`;
    await this.refreshStore.set(
      jti,
      {
        id: jti,
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + this.jwtConfig.refreshTokenTtl * 1000),
      },
      this.jwtConfig.refreshTokenTtl * 1000
    );
  }

  getRoutes(): Hono {
    const router = new Hono();

    router.get("/me", async (c) => {
      const credentials = this.extractCredentials(c);
      if (!credentials) {
        return c.json({ user: null });
      }

      const result = await this.validateCredentials(credentials);
      if (!result.success) {
        return c.json({ user: null });
      }

      return c.json({ user: result.user, expiresAt: result.expiresAt });
    });

    if (this.validatePasswordFn) {
      router.post("/login", async (c) => {
        const { email, password } = (await readJsonBody(c)) as JWTRequestBody;

        if (!email || !password) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Email and password required",
              },
            },
            400
          );
        }

        const user = await this.validatePasswordFn!(email, password);
        if (!user) {
          return c.json(
            {
              error: {
                code: "INVALID_CREDENTIALS",
                message: "Invalid email or password",
              },
            },
            401
          );
        }

        const tokens = this.generateTokens(user);

        await this.storeRefreshSession(tokens.accessToken, user.id);

        this.setRefreshCookie(c, tokens.refreshToken);

        return c.json({
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresIn,
          tokenType: "Bearer",
        });
      });
    }

    if (this.createUserFn) {
      router.post("/signup", async (c) => {
        const { email, password, name } = (await readJsonBody(c)) as JWTRequestBody;

        if (!email || !password) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Email and password required",
              },
            },
            400
          );
        }

        try {
          const user = await this.createUserFn!({ email, password, name });
          const tokens = this.generateTokens(user);

          await this.storeRefreshSession(tokens.accessToken, user.id);

          this.setRefreshCookie(c, tokens.refreshToken);

          return c.json(
            {
              accessToken: tokens.accessToken,
              expiresIn: tokens.expiresIn,
              tokenType: "Bearer",
              user: {
                id: user.id,
                email: user.email,
                name: user.name,
              },
            },
            201
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create user";
          return c.json(
            {
              error: {
                code: "SIGNUP_FAILED",
                message,
              },
            },
            400
          );
        }
      });
    }

    router.post("/refresh", async (c) => {
      const body = (await readJsonBody(c)) as JWTRequestBody;
      const refreshToken = getCookie(c, "refreshToken") ?? body?.refreshToken;

      if (!refreshToken) {
        return c.json(
          {
            error: {
              code: "NO_REFRESH_TOKEN",
              message: "Refresh token required",
            },
          },
          400
        );
      }

      try {
        const payload = jwt.verify(
          refreshToken,
          this.jwtConfig.publicKey ?? this.jwtConfig.secret,
          { algorithms: [this.jwtConfig.algorithm] }
        ) as JWTPayload;

        if (this.refreshStore) {
          const stored = await this.refreshStore.get(payload.jti!);
          if (!stored) {
            return c.json(
              {
                error: {
                  code: "TOKEN_REVOKED",
                  message: "Refresh token has been revoked",
                },
              },
              401
            );
          }
        }

        const user = await this.getUserByIdFn(payload.sub);
        if (!user) {
          return c.json(
            {
              error: { code: "USER_NOT_FOUND", message: "User not found" },
            },
            401
          );
        }

        const tokens = this.generateTokens(user);

        if (this.refreshStore) {
          const oldJti = payload.jti!;
          const newDecoded = jwt.decode(tokens.accessToken) as JWTPayload;
          const newJti = `refresh:${newDecoded.jti}`;

          await this.refreshStore.delete(oldJti);
          await this.refreshStore.set(
            newJti,
            {
              id: newJti,
              userId: user.id,
              createdAt: new Date(),
              expiresAt: new Date(
                Date.now() + this.jwtConfig.refreshTokenTtl * 1000
              ),
            },
            this.jwtConfig.refreshTokenTtl * 1000
          );

          await this.onTokenRefreshFn?.(user.id, oldJti, newJti);
        }

        this.setRefreshCookie(c, tokens.refreshToken);

        return c.json({
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresIn,
          tokenType: "Bearer",
        });
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          return c.json(
            {
              error: {
                code: "REFRESH_TOKEN_EXPIRED",
                message: "Refresh token expired",
              },
            },
            401
          );
        }
        return c.json(
          {
            error: {
              code: "INVALID_REFRESH_TOKEN",
              message: "Invalid refresh token",
            },
          },
          401
        );
      }
    });

    router.post("/logout", async (c) => {
      const body = (await readJsonBody(c)) as JWTRequestBody;
      const refreshToken = getCookie(c, "refreshToken") ?? body?.refreshToken;

      if (refreshToken && this.refreshStore) {
        try {
          const payload = jwt.decode(refreshToken) as JWTPayload | null;
          if (payload?.jti) {
            await this.refreshStore.delete(payload.jti);
          }
        } catch {
          // Ignore decode errors
        }
      }

      deleteCookie(c, "refreshToken", { path: "/" });
      return c.json({ success: true });
    });

    return router;
  }
}

export const createJWTAdapter = (options: JWTAdapterOptions): JWTAdapter => {
  return new JWTAdapter(options);
};
