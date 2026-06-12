import type { Context, Hono } from "hono";
import { UserContext } from "@/resource/types";

export interface AuthCredentials {
  type: "bearer" | "session" | "apiKey" | "basic";
  token?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  sessionId?: string;
}

export interface AuthResult {
  success: boolean;
  user?: UserContext;
  error?: string;
  expiresAt?: Date;
}

export interface SessionData {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  data?: Record<string, unknown>;
}

export interface ApiKeyData {
  id: string;
  key: string;
  userId: string;
  name: string;
  createdAt: Date;
  expiresAt?: Date;
  scopes?: string[];
  lastUsedAt?: Date;
}

export interface AuthAdapter {
  name: string;
  extractCredentials(c: Context): AuthCredentials | null;
  validateCredentials(credentials: AuthCredentials): Promise<AuthResult>;
  getSession(token: string): Promise<SessionData | null>;
  invalidateSession(token: string): Promise<void>;
  getRoutes(): Hono;
  refreshSession?(sessionId: string): Promise<SessionData | null>;
  createSession?(userId: string, data?: Record<string, unknown>): Promise<SessionData>;
  invalidateUserSessions?(userId: string, exceptSessionId?: string): Promise<void>;
}

export interface ResourceAuthConfig {
  required?: boolean;
  public?: {
    read?: boolean;
    subscribe?: boolean;
  };
  scopes?: {
    read?: (user: UserContext) => string | Promise<string>;
    create?: (user: UserContext) => string | Promise<string>;
    update?: (user: UserContext) => string | Promise<string>;
    delete?: (user: UserContext) => string | Promise<string>;
    subscribe?: (user: UserContext) => string | Promise<string>;
  };
}

export interface AuthMiddlewareOptions {
  unauthorizedMessage?: string;
  skipPaths?: string[];
  extractCredentials?: (c: Context) => AuthCredentials | null;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
  getAll?(): Promise<SessionData[]>;
  // Per-user index. When implemented, per-user operations (e.g. "log out
  // everywhere") avoid scanning every user's sessions.
  getByUser?(userId: string): Promise<SessionData[]>;
  deleteByUser?(userId: string): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, { data: SessionData; expiresAt: number }>();

  async get(sessionId: string): Promise<SessionData | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    return entry.data;
  }

  async set(sessionId: string, data: SessionData, ttlMs: number): Promise<void> {
    this.sessions.set(sessionId, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.expiresAt = Date.now() + ttlMs;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now > entry.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  async getAll(): Promise<SessionData[]> {
    this.cleanup();
    return Array.from(this.sessions.values()).map(entry => entry.data);
  }

  async getByUser(userId: string): Promise<SessionData[]> {
    return (await this.getAll()).filter((s) => s.userId === userId);
  }

  async deleteByUser(userId: string): Promise<number> {
    const sessions = await this.getByUser(userId);
    for (const s of sessions) {
      this.sessions.delete(s.id);
    }
    return sessions.length;
  }
}

export const isAuthenticated = (c: Context): boolean => {
  return c.get("user") !== undefined;
};

export const requireUser = (c: Context): UserContext => {
  const user = c.get("user");
  if (!user) {
    throw new Error("User not authenticated");
  }
  return user;
};
