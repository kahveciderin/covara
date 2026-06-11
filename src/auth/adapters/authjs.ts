import { Hono, type Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { eq, and, gt } from "drizzle-orm";
import { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { BaseAuthAdapter, createUserContext } from "../adapter";
import { AuthCredentials, AuthResult, SessionData, SessionStore } from "../types";
import { UserContext } from "@/resource/types";

export interface AuthJsAdapterOptions {
  db: unknown;
  tables: {
    users: SQLiteTableWithColumns<any>;
    sessions: SQLiteTableWithColumns<any>;
    accounts?: SQLiteTableWithColumns<any>;
    verificationTokens?: SQLiteTableWithColumns<any>;
  };
  sessionStore?: SessionStore;
  sessionTtlMs?: number;
  getUserContext?: (user: any, session: SessionData) => UserContext;
}

export class AuthJsAdapter extends BaseAuthAdapter {
  name = "authjs";
  private db: any;
  private tables: AuthJsAdapterOptions["tables"];
  private getUserContextFn: AuthJsAdapterOptions["getUserContext"];

  constructor(options: AuthJsAdapterOptions) {
    super({
      sessionStore: options.sessionStore,
      sessionTtlMs: options.sessionTtlMs,
    });
    this.db = options.db;
    this.tables = options.tables;
    this.getUserContextFn = options.getUserContext;
  }

  extractCredentials(c: Context): AuthCredentials | null {
    const sessionToken = getCookie(c, "authjs.session-token") ??
      getCookie(c, "__Secure-authjs.session-token") ??
      getCookie(c, "next-auth.session-token") ??
      getCookie(c, "__Secure-next-auth.session-token");

    if (sessionToken) {
      return { type: "session", sessionId: sessionToken };
    }

    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    const sessionToken = credentials.sessionId ?? credentials.token;
    if (!sessionToken) {
      return { success: false, error: "No session token provided" };
    }

    try {
      const sessions = await this.db
        .select()
        .from(this.tables.sessions)
        .where(
          and(
            eq(this.tables.sessions.sessionToken, sessionToken),
            gt(this.tables.sessions.expires, new Date())
          )
        )
        .limit(1);

      if (sessions.length === 0) {
        return { success: false, error: "Session not found or expired" };
      }

      const session = sessions[0];

      const users = await this.db
        .select()
        .from(this.tables.users)
        .where(eq(this.tables.users.id, session.userId))
        .limit(1);

      if (users.length === 0) {
        return { success: false, error: "User not found" };
      }

      const user = users[0];

      const sessionData: SessionData = {
        id: session.sessionToken,
        userId: session.userId,
        createdAt: session.createdAt ?? new Date(),
        expiresAt: session.expires,
      };

      let userContext: UserContext;
      if (this.getUserContextFn) {
        userContext = this.getUserContextFn(user, sessionData);
      } else {
        userContext = createUserContext(
          {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            emailVerified: user.emailVerified,
          },
          sessionData
        );
      }

      return {
        success: true,
        user: userContext,
        expiresAt: session.expires,
      };
    } catch (error) {
      console.error("Auth.js validation error:", error);
      return { success: false, error: "Authentication failed" };
    }
  }

  async getSession(token: string): Promise<SessionData | null> {
    try {
      const sessions = await this.db
        .select()
        .from(this.tables.sessions)
        .where(
          and(
            eq(this.tables.sessions.sessionToken, token),
            gt(this.tables.sessions.expires, new Date())
          )
        )
        .limit(1);

      if (sessions.length === 0) return null;

      const session = sessions[0];
      return {
        id: session.sessionToken,
        userId: session.userId,
        createdAt: session.createdAt ?? new Date(),
        expiresAt: session.expires,
      };
    } catch {
      return null;
    }
  }

  async invalidateSession(token: string): Promise<void> {
    try {
      await this.db
        .delete(this.tables.sessions)
        .where(eq(this.tables.sessions.sessionToken, token));
    } catch (error) {
      console.error("Failed to invalidate session:", error);
    }
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

    router.post("/logout", async (c) => {
      const credentials = this.extractCredentials(c);
      if (credentials?.sessionId) {
        await this.invalidateSession(credentials.sessionId);
      }
      deleteCookie(c, "authjs.session-token");
      deleteCookie(c, "__Secure-authjs.session-token");
      return c.json({ success: true });
    });

    return router;
  }
}

export const createAuthJsAdapter = (options: AuthJsAdapterOptions): AuthJsAdapter => {
  return new AuthJsAdapter(options);
};
