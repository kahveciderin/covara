import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  AuthAdapter,
  AuthCredentials,
  AuthResult,
  SessionData,
  SessionStore,
  InMemorySessionStore,
} from "./types";
import { UserContext } from "@/resource/types";

export abstract class BaseAuthAdapter implements AuthAdapter {
  abstract name: string;
  readonly sessionStore: SessionStore;
  protected sessionTtlMs: number;

  constructor(options: { sessionStore?: SessionStore; sessionTtlMs?: number } = {}) {
    this.sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  }

  extractCredentials(c: Context): AuthCredentials | null {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      const sessionId = getCookie(c, "session");
      if (sessionId) {
        return { type: "session", sessionId };
      }
      return null;
    }

    if (authHeader.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    if (authHeader.startsWith("Basic ")) {
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

  abstract validateCredentials(credentials: AuthCredentials): Promise<AuthResult>;

  async getSession(token: string): Promise<SessionData | null> {
    const session = await this.sessionStore.get(token);
    if (session) {
      void this.recordSessionActivity(session);
    }
    return session;
  }

  // Stamp session.data.lastActiveAt so the admin UI can show when a session
  // was last used. Throttled to one persisted write per minute per session and
  // fire-and-forget, so it adds no latency or write amplification to requests.
  private async recordSessionActivity(session: SessionData): Promise<void> {
    const now = Date.now();
    const last =
      typeof session.data?.lastActiveAt === "number" ? session.data.lastActiveAt : 0;
    if (now - last < 60_000) return;
    const remainingTtl = session.expiresAt.getTime() - now;
    if (remainingTtl <= 0) return;
    session.data = { ...session.data, lastActiveAt: now };
    try {
      await this.sessionStore.set(session.id, session, remainingTtl);
    } catch {
      // best effort — activity tracking must never break auth
    }
  }

  async invalidateSession(token: string): Promise<void> {
    await this.sessionStore.delete(token);
  }

  async createSession(
    userId: string,
    data?: Record<string, unknown>
  ): Promise<SessionData> {
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    const session: SessionData = {
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt,
      data,
    };

    await this.sessionStore.set(sessionId, session, this.sessionTtlMs);
    return session;
  }

  async invalidateUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
    // Prefer the store's per-user index (Redis/Drizzle stores maintain one) so
    // this never scans every user's sessions to log out one user.
    if (!exceptSessionId && this.sessionStore.deleteByUser) {
      await this.sessionStore.deleteByUser(userId);
      return;
    }
    if (this.sessionStore.getByUser) {
      const sessions = await this.sessionStore.getByUser(userId);
      await Promise.all(
        sessions
          .filter((s) => s.id !== exceptSessionId)
          .map((s) => this.sessionStore.delete(s.id))
      );
      return;
    }
    if (!this.sessionStore.getAll) return;
    const sessions = await this.sessionStore.getAll();
    await Promise.all(
      sessions
        .filter((s) => s.userId === userId && s.id !== exceptSessionId)
        .map((s) => this.sessionStore.delete(s.id))
    );
  }

  async refreshSession(sessionId: string): Promise<SessionData | null> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) return null;

    const now = new Date();
    session.expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.sessionStore.set(sessionId, session, this.sessionTtlMs);

    return session;
  }

  abstract getRoutes(): Hono;
}

export class CompositeAuthAdapter implements AuthAdapter {
  name = "composite";
  private adapters: AuthAdapter[];

  constructor(adapters: AuthAdapter[]) {
    this.adapters = adapters;
  }

  extractCredentials(c: Context): AuthCredentials | null {
    for (const adapter of this.adapters) {
      const credentials = adapter.extractCredentials(c);
      if (credentials) return credentials;
    }
    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    for (const adapter of this.adapters) {
      try {
        const result = await adapter.validateCredentials(credentials);
        if (result.success) return result;
      } catch {
        continue;
      }
    }
    return { success: false, error: "Invalid credentials" };
  }

  async getSession(token: string): Promise<SessionData | null> {
    for (const adapter of this.adapters) {
      const session = await adapter.getSession(token);
      if (session) return session;
    }
    return null;
  }

  async invalidateSession(token: string): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.invalidateSession(token)));
  }

  getRoutes(): Hono {
    const router = new Hono();
    for (const adapter of this.adapters) {
      router.route(`/${adapter.name}`, adapter.getRoutes());
    }
    return router;
  }
}

export class NullAuthAdapter implements AuthAdapter {
  name = "null";

  extractCredentials(_c: Context): AuthCredentials | null {
    return null;
  }

  async validateCredentials(_credentials: AuthCredentials): Promise<AuthResult> {
    return { success: false, error: "No authentication configured" };
  }

  async getSession(_token: string): Promise<SessionData | null> {
    return null;
  }

  async invalidateSession(_token: string): Promise<void> {}

  getRoutes(): Hono {
    return new Hono();
  }
}

export const createUserContext = (
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    emailVerified?: Date | null;
    metadata?: Record<string, unknown>;
  },
  session: SessionData
): UserContext => ({
  id: user.id,
  email: user.email ?? null,
  name: user.name ?? null,
  image: user.image ?? null,
  emailVerified: user.emailVerified ?? null,
  sessionId: session.id,
  sessionExpiresAt: session.expiresAt,
  metadata: user.metadata,
});
