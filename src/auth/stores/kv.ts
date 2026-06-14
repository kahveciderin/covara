import { SessionData, SessionStore } from "../types";
import { KVAdapter } from "@/kv/types";

export interface KVSessionStoreOptions {
  kv: KVAdapter;
  prefix?: string;
  onError?: (error: Error) => void;
}

export class KVSessionStore implements SessionStore {
  private kv: KVAdapter;
  private prefix: string;
  private onError?: (error: Error) => void;

  constructor(options: KVSessionStoreOptions) {
    this.kv = options.kv;
    this.prefix = options.prefix ?? "session";
    this.onError = options.onError;
  }

  private key(sessionId: string): string {
    return `${this.prefix}:${sessionId}`;
  }

  private userKey(userId: string): string {
    return `${this.prefix}:user:${userId}`;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    try {
      const data = await this.kv.hgetall(this.key(sessionId));
      if (!data || !data.id) return null;

      return {
        id: data.id,
        userId: data.userId,
        createdAt: new Date(data.createdAt),
        expiresAt: new Date(data.expiresAt),
        data: data.data ? JSON.parse(data.data) : undefined,
      };
    } catch (error) {
      this.onError?.(error as Error);
      return null;
    }
  }

  async set(sessionId: string, session: SessionData, ttlMs: number): Promise<void> {
    try {
      const key = this.key(sessionId);
      const data: Record<string, string> = {
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      };

      if (session.data) {
        data.data = JSON.stringify(session.data);
      }

      await this.kv.hmset(key, data);
      await this.kv.expire(key, Math.ceil(ttlMs / 1000));
      await this.kv.sadd(this.userKey(session.userId), sessionId);
    } catch (error) {
      this.onError?.(error as Error);
      throw error;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      const session = await this.get(sessionId);
      if (session) {
        await this.kv.srem(this.userKey(session.userId), sessionId);
      }
      await this.kv.del(this.key(sessionId));
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    try {
      const key = this.key(sessionId);
      const exists = await this.kv.exists(key);
      if (exists) {
        await this.kv.expire(key, Math.ceil(ttlMs / 1000));
        await this.kv.hset(
          key,
          "expiresAt",
          new Date(Date.now() + ttlMs).toISOString()
        );
      }
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async getAll(): Promise<SessionData[]> {
    try {
      const keys = await this.kv.keys(`${this.prefix}:*`);
      const sessions: SessionData[] = [];

      for (const key of keys) {
        if (key.includes(":user:")) continue;

        const sessionId = key.replace(`${this.prefix}:`, "");
        const session = await this.get(sessionId);
        if (session) {
          sessions.push(session);
        }
      }

      return sessions;
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async getByUser(userId: string): Promise<SessionData[]> {
    try {
      const sessionIds = await this.kv.smembers(this.userKey(userId));
      const sessions: SessionData[] = [];

      for (const sessionId of sessionIds) {
        const session = await this.get(sessionId);
        if (session) {
          sessions.push(session);
        } else {
          await this.kv.srem(this.userKey(userId), sessionId);
        }
      }

      return sessions;
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async deleteByUser(userId: string): Promise<number> {
    try {
      const sessionIds = await this.kv.smembers(this.userKey(userId));
      let deleted = 0;

      for (const sessionId of sessionIds) {
        await this.kv.del(this.key(sessionId));
        deleted++;
      }

      await this.kv.del(this.userKey(userId));
      return deleted;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }

  async count(): Promise<number> {
    try {
      const keys = await this.kv.keys(`${this.prefix}:*`);
      return keys.filter((k) => !k.includes(":user:")).length;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }
}

export const createKVSessionStore = (
  options: KVSessionStoreOptions
): KVSessionStore => {
  return new KVSessionStore(options);
};

/** @deprecated Use {@link KVSessionStoreOptions}. Works with any KV adapter, not only Redis. */
export type RedisSessionStoreOptions = KVSessionStoreOptions;
/** @deprecated Use {@link KVSessionStore}. Works with any KV adapter, not only Redis. */
export const RedisSessionStore = KVSessionStore;
/** @deprecated Use {@link createKVSessionStore}. Works with any KV adapter, not only Redis. */
export const createRedisSessionStore = createKVSessionStore;
