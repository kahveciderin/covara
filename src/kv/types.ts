/**
 * KV Store Adapter Interface
 *
 * Provides a Redis-like API that can be backed by either:
 * - In-memory store (for development/single process)
 * - Redis (for production/multi-process)
 *
 * All operations are async to support both backends uniformly.
 */

export interface KVAdapter {
  // Connection
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // String operations
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: SetOptions): Promise<void>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  incrBy(key: string, increment: number): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  ttl(key: string): Promise<number>;

  // Hash operations (for storing objects)
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hmset(key: string, data: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hexists(key: string, field: string): Promise<boolean>;
  hkeys(key: string): Promise<string[]>;
  hlen(key: string): Promise<number>;

  // Set operations (for unique collections)
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  scard(key: string): Promise<number>;

  // List operations (for ordered collections like changelog)
  lpush(key: string, ...values: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string): Promise<string | null>;
  rpop(key: string): Promise<string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;

  // Sorted set operations (for ordered data with scores, like sequences)
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zscore(key: string, member: string): Promise<number | null>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
    options?: ZRangeOptions
  ): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zincrby(key: string, increment: number, member: string): Promise<number>;

  // Key scanning (for iteration)
  keys(pattern: string): Promise<string[]>;
  scan(cursor: string, options?: ScanOptions): Promise<ScanResult>;

  // Pub/Sub (for cross-process notifications)
  publish(channel: string, message: string): Promise<number>;
  subscribe(
    channel: string,
    callback: (message: string, channel: string) => void
  ): Promise<void>;
  psubscribe(
    pattern: string,
    callback: (message: string, channel: string) => void
  ): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  punsubscribe(pattern: string): Promise<void>;

  // Transactions (for atomic operations)
  multi(): KVTransaction;

  // Lua scripting (for complex atomic operations)
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface KVTransaction {
  get(key: string): KVTransaction;
  set(key: string, value: string, options?: SetOptions): KVTransaction;
  del(...keys: string[]): KVTransaction;
  incr(key: string): KVTransaction;
  hset(key: string, field: string, value: string): KVTransaction;
  hdel(key: string, ...fields: string[]): KVTransaction;
  sadd(key: string, ...members: string[]): KVTransaction;
  srem(key: string, ...members: string[]): KVTransaction;
  lpush(key: string, ...values: string[]): KVTransaction;
  rpush(key: string, ...values: string[]): KVTransaction;
  zadd(key: string, score: number, member: string): KVTransaction;
  zrem(key: string, ...members: string[]): KVTransaction;
  expire(key: string, seconds: number): KVTransaction;
  exec(): Promise<unknown[]>;
  discard(): void;
}

export interface SetOptions {
  ex?: number; // Expire time in seconds
  px?: number; // Expire time in milliseconds
  nx?: boolean; // Only set if not exists
  xx?: boolean; // Only set if exists
}

export interface ZRangeOptions {
  limit?: { offset: number; count: number };
  withScores?: boolean;
}

export interface ScanOptions {
  match?: string;
  count?: number;
}

export interface ScanResult {
  cursor: string;
  keys: string[];
}

export interface KVConfig {
  type: "memory" | "redis" | "durable-object";
  prefix?: string; // Key prefix for namespacing
  redis?: RedisConfig;
  durableObject?: DurableObjectConfig;
}

// Structural stand-ins for Cloudflare types so this module never imports
// from cloudflare:workers and stays compilable under Node
export interface DurableObjectStubLike {
  fetch(
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface DurableObjectConfig {
  namespace: DurableObjectNamespaceLike;
  name?: string;
}

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  tls?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

// Global KV store instance
let globalKV: KVAdapter | null = null;

export const setGlobalKV = (kv: KVAdapter): void => {
  globalKV = kv;
};

export const getGlobalKV = (): KVAdapter => {
  if (!globalKV) {
    throw new Error(
      "KV store not initialized. Call setGlobalKV() or createKV() first."
    );
  }
  return globalKV;
};

export const hasGlobalKV = (): boolean => {
  return globalKV !== null;
};

export const clearGlobalKV = (): void => {
  globalKV = null;
};
