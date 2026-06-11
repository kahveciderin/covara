import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { BaseAuthAdapter, createUserContext } from "../adapter";
import { AuthCredentials, AuthResult, SessionData, SessionStore } from "../types";
import { UserContext } from "@/resource/types";
import { readJsonBody } from "@/server/request";
import { isProduction } from "@/server/env";

export interface PassportAdapterOptions {
  getUserById: (id: string) => Promise<{
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    emailVerified?: Date | null;
    metadata?: Record<string, unknown>;
  } | null>;
  validatePassword?: (username: string, password: string) => Promise<{
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    emailVerified?: Date | null;
    metadata?: Record<string, unknown>;
  } | null>;
  validateApiKey?: (apiKey: string) => Promise<{
    userId: string;
    scopes?: string[];
  } | null>;
  sessionStore?: SessionStore;
  sessionTtlMs?: number;
  getUserContext?: (user: any, session: SessionData) => UserContext;
}

export class PassportAdapter extends BaseAuthAdapter {
  name = "passport";
  private getUserById: PassportAdapterOptions["getUserById"];
  private validatePassword?: PassportAdapterOptions["validatePassword"];
  private validateApiKey?: PassportAdapterOptions["validateApiKey"];
  private getUserContextFn?: PassportAdapterOptions["getUserContext"];

  constructor(options: PassportAdapterOptions) {
    super({
      sessionStore: options.sessionStore,
      sessionTtlMs: options.sessionTtlMs,
    });
    this.getUserById = options.getUserById;
    this.validatePassword = options.validatePassword;
    this.validateApiKey = options.validateApiKey;
    this.getUserContextFn = options.getUserContext;
  }

  extractCredentials(c: Context): AuthCredentials | null {
    const passportSessionId = getCookie(c, "connect.sid");
    if (passportSessionId) {
      return { type: "session", sessionId: passportSessionId };
    }

    const sessionCookie = getCookie(c, "session");
    if (sessionCookie) {
      return { type: "session", sessionId: sessionCookie };
    }

    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    if (authHeader?.startsWith("Basic ")) {
      const base64 = authHeader.slice(6);
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const [username, password] = decoded.split(":");
      return { type: "basic", username, password };
    }

    const apiKey = c.req.header("x-api-key");
    if (typeof apiKey === "string") {
      return { type: "apiKey", apiKey };
    }

    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    try {
      switch (credentials.type) {
        case "session": {
          if (!credentials.sessionId) {
            return { success: false, error: "No session ID" };
          }

          const session = await this.getSession(credentials.sessionId);
          if (!session) {
            return { success: false, error: "Session not found or expired" };
          }

          const user = await this.getUserById(session.userId);
          if (!user) {
            return { success: false, error: "User not found" };
          }

          const userContext = this.createContext(user, session);
          return { success: true, user: userContext, expiresAt: session.expiresAt };
        }

        case "bearer": {
          if (!credentials.token) {
            return { success: false, error: "No token provided" };
          }

          const session = await this.getSession(credentials.token);
          if (!session) {
            return { success: false, error: "Invalid token" };
          }

          const user = await this.getUserById(session.userId);
          if (!user) {
            return { success: false, error: "User not found" };
          }

          const userContext = this.createContext(user, session);
          return { success: true, user: userContext, expiresAt: session.expiresAt };
        }

        case "basic": {
          if (!this.validatePassword) {
            return { success: false, error: "Password authentication not configured" };
          }

          if (!credentials.username || !credentials.password) {
            return { success: false, error: "Username and password required" };
          }

          const user = await this.validatePassword(
            credentials.username,
            credentials.password
          );
          if (!user) {
            return { success: false, error: "Invalid credentials" };
          }

          const session = await this.createSession(user.id);
          const userContext = this.createContext(user, session);
          return { success: true, user: userContext, expiresAt: session.expiresAt };
        }

        case "apiKey": {
          if (!this.validateApiKey) {
            return { success: false, error: "API key authentication not configured" };
          }

          if (!credentials.apiKey) {
            return { success: false, error: "API key required" };
          }

          const keyData = await this.validateApiKey(credentials.apiKey);
          if (!keyData) {
            return { success: false, error: "Invalid API key" };
          }

          const user = await this.getUserById(keyData.userId);
          if (!user) {
            return { success: false, error: "User not found" };
          }

          const session: SessionData = {
            id: `apikey:${credentials.apiKey.slice(0, 8)}`,
            userId: user.id,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + this.sessionTtlMs),
            data: { scopes: keyData.scopes },
          };

          const userContext = this.createContext(user, session);
          if (keyData.scopes) {
            userContext.metadata = {
              ...userContext.metadata,
              apiKeyScopes: keyData.scopes,
            };
          }

          return { success: true, user: userContext };
        }

        default:
          return { success: false, error: "Unsupported credential type" };
      }
    } catch (error) {
      console.error("Passport validation error:", error);
      return { success: false, error: "Authentication failed" };
    }
  }

  private createContext(
    user: NonNullable<Awaited<ReturnType<PassportAdapterOptions["getUserById"]>>>,
    session: SessionData
  ): UserContext {
    if (this.getUserContextFn) {
      return this.getUserContextFn(user, session);
    }
    return createUserContext(user, session);
  }

  getRoutes(): Hono {
    const router = new Hono();

    router.get("/session", async (c) => {
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

    if (this.validatePassword) {
      router.post("/login", async (c) => {
        const { username, password } = (await readJsonBody(c)) as {
          username?: string;
          password?: string;
        };

        if (!username || !password) {
          return c.json(
            {
              error: { code: "INVALID_INPUT", message: "Username and password required" },
            },
            400
          );
        }

        const user = await this.validatePassword!(username, password);
        if (!user) {
          return c.json(
            {
              error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" },
            },
            401
          );
        }

        const session = await this.createSession(user.id);
        const userContext = this.createContext(user, session);

        setCookie(c, "session", session.id, {
          httpOnly: true,
          secure: isProduction(),
          sameSite: "lax",
          expires: session.expiresAt,
        });

        return c.json({ user: userContext, sessionId: session.id });
      });
    }

    router.post("/logout", async (c) => {
      const credentials = this.extractCredentials(c);
      if (credentials?.sessionId) {
        await this.invalidateSession(credentials.sessionId);
      }

      deleteCookie(c, "session");
      deleteCookie(c, "connect.sid");

      return c.json({ success: true });
    });

    return router;
  }
}

export const createPassportAdapter = (options: PassportAdapterOptions): PassportAdapter => {
  return new PassportAdapter(options);
};

export const fromPassportUser = (
  passportUser: any,
  sessionId: string
): UserContext => {
  const session: SessionData = {
    id: sessionId,
    userId: passportUser.id,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

  return createUserContext(
    {
      id: passportUser.id,
      email: passportUser.email,
      name: passportUser.name ?? passportUser.displayName,
      image: passportUser.image ?? passportUser.avatar,
      emailVerified: passportUser.emailVerified,
      metadata: passportUser.metadata,
    },
    session
  );
};
