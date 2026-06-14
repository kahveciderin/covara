import { eq, and, gt, lt } from "drizzle-orm";
import { SessionData, SessionStore } from "../types";
import { DrizzleDatabase } from "@/resource/types";
import {
  SESSION_KEYS,
  makeIdentityResolver,
  type SessionKey,
  type TableResolver,
} from "@/db/internal-schema";

export interface SessionsTableColumns {
  id: unknown;
  userId: unknown;
  createdAt: unknown;
  expiresAt: unknown;
  data: unknown;
}

export interface DrizzleSessionStoreOptions {
  db: DrizzleDatabase;
  table?: {
    id: unknown;
    userId: unknown;
    createdAt: unknown;
    expiresAt: unknown;
    data: unknown;
  } & Record<string, unknown>;
  resolver?: TableResolver<SessionKey>;
  cleanupIntervalMs?: number;
  onError?: (error: Error) => void;
}

export class DrizzleSessionStore implements SessionStore {
  private db: DrizzleDatabase;
  private resolver: TableResolver<SessionKey>;
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private onError?: (error: Error) => void;

  constructor(options: DrizzleSessionStoreOptions) {
    this.db = options.db;
    if (options.resolver) {
      this.resolver = options.resolver;
    } else if (options.table) {
      this.resolver = makeIdentityResolver(
        options.table as Record<string, unknown>,
        SESSION_KEYS,
        "sessions"
      );
    } else {
      throw new Error("DrizzleSessionStore requires either `resolver` or `table`");
    }
    this.onError = options.onError;

    if (options.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        options.cleanupIntervalMs
      );
    }
  }

  private get table(): Record<string, unknown> {
    return this.resolver.table;
  }

  private toSession(row: Record<string, unknown>): SessionData {
    const r = this.resolver;
    const createdAt = row[r.prop("createdAt")];
    const expiresAt = row[r.prop("expiresAt")];
    const data = r.has("data") ? row[r.prop("data")] : undefined;
    return {
      id: row[r.prop("id")] as string,
      userId: row[r.prop("userId")] as string,
      createdAt:
        createdAt instanceof Date
          ? createdAt
          : new Date(createdAt as string | number),
      expiresAt:
        expiresAt instanceof Date
          ? expiresAt
          : new Date(expiresAt as string | number),
      data: data
        ? typeof data === "string"
          ? JSON.parse(data)
          : (data as Record<string, unknown>)
        : undefined,
    };
  }

  async get(sessionId: string): Promise<SessionData | null> {
    try {
      const r = this.resolver;
      const results = await this.db
        .select()
        .from(this.table as never)
        .where(
          and(
            eq(r.col("id") as never, sessionId),
            gt(r.col("expiresAt") as never, new Date())
          )
        )
        .limit(1);

      if (results.length === 0) return null;
      return this.toSession(results[0] as Record<string, unknown>);
    } catch (error) {
      this.onError?.(error as Error);
      return null;
    }
  }

  async set(
    sessionId: string,
    session: SessionData,
    _ttlMs: number
  ): Promise<void> {
    try {
      const r = this.resolver;
      const existing = await this.db
        .select({ id: r.col("id") as never })
        .from(this.table as never)
        .where(eq(r.col("id") as never, sessionId))
        .limit(1);

      const dataValue = session.data ? JSON.stringify(session.data) : null;

      if (existing.length > 0) {
        const set: Record<string, unknown> = {
          [r.prop("userId")]: session.userId,
          [r.prop("expiresAt")]: session.expiresAt,
        };
        if (r.has("data")) set[r.prop("data")] = dataValue;
        await this.db
          .update(this.table as never)
          .set(set as never)
          .where(eq(r.col("id") as never, sessionId));
      } else {
        const values: Record<string, unknown> = {
          [r.prop("id")]: session.id,
          [r.prop("userId")]: session.userId,
          [r.prop("createdAt")]: session.createdAt,
          [r.prop("expiresAt")]: session.expiresAt,
        };
        if (r.has("data")) values[r.prop("data")] = dataValue;
        await this.db.insert(this.table as never).values(values as never);
      }
    } catch (error) {
      this.onError?.(error as Error);
      throw error;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.db
        .delete(this.table as never)
        .where(eq(this.resolver.col("id") as never, sessionId));
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    try {
      const r = this.resolver;
      await this.db
        .update(this.table as never)
        .set({ [r.prop("expiresAt")]: new Date(Date.now() + ttlMs) } as never)
        .where(eq(r.col("id") as never, sessionId));
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async getAll(): Promise<SessionData[]> {
    try {
      const rows = (await this.db
        .select()
        .from(this.table as never)
        .where(gt(this.resolver.col("expiresAt") as never, new Date()))) as Record<
        string,
        unknown
      >[];

      return rows.map((row) => this.toSession(row));
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async getByUser(userId: string): Promise<SessionData[]> {
    try {
      const r = this.resolver;
      const rows = (await this.db
        .select()
        .from(this.table as never)
        .where(
          and(
            eq(r.col("userId") as never, userId),
            gt(r.col("expiresAt") as never, new Date())
          )
        )) as Record<string, unknown>[];

      return rows.map((row) => this.toSession(row));
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async deleteByUser(userId: string): Promise<number> {
    try {
      const result = await this.db
        .delete(this.table as never)
        .where(eq(this.resolver.col("userId") as never, userId));

      return (result as { changes?: number }).changes ?? 0;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }

  async cleanup(): Promise<number> {
    try {
      const result = await this.db
        .delete(this.table as never)
        .where(lt(this.resolver.col("expiresAt") as never, new Date()));

      return (result as { changes?: number }).changes ?? 0;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export const createDrizzleSessionStore = (
  options: DrizzleSessionStoreOptions
): DrizzleSessionStore => {
  return new DrizzleSessionStore(options);
};
