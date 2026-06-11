/**
 * Redis KV Store Adapter
 *
 * Wraps ioredis (or compatible Redis client) to implement the KV adapter interface.
 * Suitable for production multi-process deployments.
 *
 * Requires: npm install ioredis
 */

import {
  KVAdapter,
  KVTransaction,
  SetOptions,
  ZRangeOptions,
  ScanOptions,
  ScanResult,
  RedisConfig,
} from "./types";

// Type definitions for ioredis-compatible client
interface RedisClient {
  connect?(): Promise<void>;
  quit(): Promise<string>;
  status?: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hmset(key: string, data: Record<string, string>): Promise<string>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hexists(key: string, field: string): Promise<number>;
  hkeys(key: string): Promise<string[]>;
  hlen(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string): Promise<string | null>;
  rpop(key: string): Promise<string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: unknown[]
  ): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zincrby(key: string, increment: number, member: string): Promise<string>;
  keys(pattern: string): Promise<string[]>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<number>;
  psubscribe(pattern: string): Promise<number>;
  unsubscribe(channel: string): Promise<number>;
  punsubscribe(pattern: string): Promise<number>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  multi(): RedisMulti;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  duplicate(): RedisClient;
}

interface RedisMulti {
  get(key: string): RedisMulti;
  set(key: string, value: string, ...args: unknown[]): RedisMulti;
  del(...keys: string[]): RedisMulti;
  incr(key: string): RedisMulti;
  hset(key: string, field: string, value: string): RedisMulti;
  hdel(key: string, ...fields: string[]): RedisMulti;
  sadd(key: string, ...members: string[]): RedisMulti;
  srem(key: string, ...members: string[]): RedisMulti;
  lpush(key: string, ...values: string[]): RedisMulti;
  rpush(key: string, ...values: string[]): RedisMulti;
  zadd(key: string, score: number, member: string): RedisMulti;
  zrem(key: string, ...members: string[]): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

type SubscriptionCallback = (message: string, channel: string) => void;

export class RedisKVStore implements KVAdapter {
  private client: RedisClient;
  private subClient: RedisClient | null = null;
  private prefix: string;
  private subscriptionCallbacks = new Map<string, Set<SubscriptionCallback>>();
  private patternCallbacks = new Map<string, Set<SubscriptionCallback>>();
  private connected = false;

  constructor(client: RedisClient, prefix = "") {
    this.client = client;
    this.prefix = prefix;
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  private unkey(k: string): string {
    return this.prefix ? k.slice(this.prefix.length + 1) : k;
  }

  async connect(): Promise<void> {
    if (this.client.connect) {
      await this.client.connect();
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    if (this.subClient) {
      await this.subClient.quit();
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected || this.client.status === "ready";
  }

  // String operations

  async get(key: string): Promise<string | null> {
    return this.client.get(this.key(key));
  }

  async set(key: string, value: string, options?: SetOptions): Promise<void> {
    const args: unknown[] = [this.key(key), value];

    if (options?.ex) {
      args.push("EX", options.ex);
    } else if (options?.px) {
      args.push("PX", options.px);
    }

    if (options?.nx) {
      args.push("NX");
    } else if (options?.xx) {
      args.push("XX");
    }

    await this.client.set(args[0] as string, args[1] as string, ...args.slice(2));
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys.map((k) => this.key(k)));
  }

  async exists(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.exists(...keys.map((k) => this.key(k)));
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(this.key(key));
  }

  async incrBy(key: string, increment: number): Promise<number> {
    return this.client.incrby(this.key(key), increment);
  }

  async decr(key: string): Promise<number> {
    return this.client.decr(this.key(key));
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.client.expire(this.key(key), seconds);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(this.key(key));
  }

  // Hash operations

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(this.key(key), field);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(this.key(key), field, value);
  }

  async hmset(key: string, data: Record<string, string>): Promise<void> {
    await this.client.hmset(this.key(key), data);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(this.key(key));
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.client.hdel(this.key(key), ...fields);
  }

  async hexists(key: string, field: string): Promise<boolean> {
    const result = await this.client.hexists(this.key(key), field);
    return result === 1;
  }

  async hkeys(key: string): Promise<string[]> {
    return this.client.hkeys(this.key(key));
  }

  async hlen(key: string): Promise<number> {
    return this.client.hlen(this.key(key));
  }

  // Set operations

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.sadd(this.key(key), ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.srem(this.key(key), ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(this.key(key));
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.client.sismember(this.key(key), member);
    return result === 1;
  }

  async scard(key: string): Promise<number> {
    return this.client.scard(this.key(key));
  }

  // List operations

  async lpush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    return this.client.lpush(this.key(key), ...values);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    return this.client.rpush(this.key(key), ...values);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(this.key(key));
  }

  async rpop(key: string): Promise<string | null> {
    return this.client.rpop(this.key(key));
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(this.key(key), start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(this.key(key));
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(this.key(key), start, stop);
  }

  // Sorted set operations

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(this.key(key), score, member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.zrem(this.key(key), ...members);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const result = await this.client.zscore(this.key(key), member);
    return result !== null ? parseFloat(result) : null;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zrange(this.key(key), start, stop);
  }

  async zrangebyscore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
    options?: ZRangeOptions
  ): Promise<string[]> {
    const args: unknown[] = [];

    if (options?.limit) {
      args.push("LIMIT", options.limit.offset, options.limit.count);
    }

    return this.client.zrangebyscore(
      this.key(key),
      min === "-inf" ? "-inf" : min,
      max === "+inf" ? "+inf" : max,
      ...args
    );
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(this.key(key));
  }

  async zincrby(
    key: string,
    increment: number,
    member: string
  ): Promise<number> {
    const result = await this.client.zincrby(this.key(key), increment, member);
    return parseFloat(result);
  }

  // Key scanning

  async keys(pattern: string): Promise<string[]> {
    const keys = await this.client.keys(this.key(pattern));
    return keys.map((k) => this.unkey(k));
  }

  async scan(cursor: string, options?: ScanOptions): Promise<ScanResult> {
    const args: unknown[] = [];

    if (options?.match) {
      args.push("MATCH", this.key(options.match));
    }

    if (options?.count) {
      args.push("COUNT", options.count);
    }

    const [newCursor, keys] = await this.client.scan(cursor, ...args);

    return {
      cursor: newCursor,
      keys: keys.map((k) => this.unkey(k)),
    };
  }

  // Pub/Sub

  private async ensureSubClient(): Promise<RedisClient> {
    if (!this.subClient) {
      this.subClient = this.client.duplicate();
      if (this.subClient.connect) {
        await this.subClient.connect();
      }

      this.subClient.on("message", (...args: unknown[]) => {
        const [channel, message] = args as [string, string];
        const callbacks = this.subscriptionCallbacks.get(channel);
        if (callbacks) {
          for (const callback of callbacks) {
            callback(message, channel);
          }
        }
      });

      this.subClient.on("pmessage", (...args: unknown[]) => {
        const [pattern, channel, message] = args as [string, string, string];
        const callbacks = this.patternCallbacks.get(pattern);
        if (callbacks) {
          for (const callback of callbacks) {
            callback(message, channel);
          }
        }
      });
    }
    return this.subClient;
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async subscribe(
    channel: string,
    callback: (message: string, channel: string) => void
  ): Promise<void> {
    const subClient = await this.ensureSubClient();

    if (!this.subscriptionCallbacks.has(channel)) {
      this.subscriptionCallbacks.set(channel, new Set());
      await subClient.subscribe(channel);
    }

    this.subscriptionCallbacks.get(channel)!.add(callback);
  }

  async psubscribe(
    pattern: string,
    callback: (message: string, channel: string) => void
  ): Promise<void> {
    const subClient = await this.ensureSubClient();

    if (!this.patternCallbacks.has(pattern)) {
      this.patternCallbacks.set(pattern, new Set());
      await subClient.psubscribe(pattern);
    }

    this.patternCallbacks.get(pattern)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptionCallbacks.delete(channel);
    if (this.subClient) {
      await this.subClient.unsubscribe(channel);
    }
  }

  async punsubscribe(pattern: string): Promise<void> {
    this.patternCallbacks.delete(pattern);
    if (this.subClient) {
      await this.subClient.punsubscribe(pattern);
    }
  }

  // Transactions

  multi(): KVTransaction {
    return new RedisTransaction(this.client.multi(), this.prefix);
  }

  // Lua scripting

  async eval(
    script: string,
    keys: string[],
    args: string[]
  ): Promise<unknown> {
    const prefixedKeys = keys.map((k) => this.key(k));
    return this.client.eval(script, keys.length, ...prefixedKeys, ...args);
  }
}

class RedisTransaction implements KVTransaction {
  private multi: RedisMulti;
  private prefix: string;

  constructor(multi: RedisMulti, prefix: string) {
    this.multi = multi;
    this.prefix = prefix;
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  get(key: string): KVTransaction {
    this.multi.get(this.key(key));
    return this;
  }

  set(key: string, value: string, options?: SetOptions): KVTransaction {
    const args: unknown[] = [];

    if (options?.ex) {
      args.push("EX", options.ex);
    } else if (options?.px) {
      args.push("PX", options.px);
    }

    if (options?.nx) {
      args.push("NX");
    } else if (options?.xx) {
      args.push("XX");
    }

    this.multi.set(this.key(key), value, ...args);
    return this;
  }

  del(...keys: string[]): KVTransaction {
    this.multi.del(...keys.map((k) => this.key(k)));
    return this;
  }

  incr(key: string): KVTransaction {
    this.multi.incr(this.key(key));
    return this;
  }

  hset(key: string, field: string, value: string): KVTransaction {
    this.multi.hset(this.key(key), field, value);
    return this;
  }

  hdel(key: string, ...fields: string[]): KVTransaction {
    this.multi.hdel(this.key(key), ...fields);
    return this;
  }

  sadd(key: string, ...members: string[]): KVTransaction {
    this.multi.sadd(this.key(key), ...members);
    return this;
  }

  srem(key: string, ...members: string[]): KVTransaction {
    this.multi.srem(this.key(key), ...members);
    return this;
  }

  lpush(key: string, ...values: string[]): KVTransaction {
    this.multi.lpush(this.key(key), ...values);
    return this;
  }

  rpush(key: string, ...values: string[]): KVTransaction {
    this.multi.rpush(this.key(key), ...values);
    return this;
  }

  zadd(key: string, score: number, member: string): KVTransaction {
    this.multi.zadd(this.key(key), score, member);
    return this;
  }

  zrem(key: string, ...members: string[]): KVTransaction {
    this.multi.zrem(this.key(key), ...members);
    return this;
  }

  expire(key: string, seconds: number): KVTransaction {
    this.multi.expire(this.key(key), seconds);
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results = await this.multi.exec();
    if (!results) return [];
    // ioredis returns [err, result] tuples
    return results.map(([err, result]) => {
      if (err) throw err;
      return result;
    });
  }

  discard(): void {
    // Redis MULTI/EXEC doesn't have explicit discard in ioredis
    // The transaction is discarded when the multi object is abandoned
  }
}

/**
 * Create a Redis KV adapter from an existing ioredis client
 */
export const createRedisKV = (
  client: RedisClient,
  prefix?: string
): KVAdapter => {
  return new RedisKVStore(client, prefix);
};

/**
 * Create a Redis KV adapter from config
 * Requires ioredis to be installed: npm install ioredis
 */
export const createRedisKVFromConfig = async (
  config: RedisConfig,
  prefix?: string
): Promise<KVAdapter> => {
  // Dynamic import to make ioredis optional
  let Redis: new (...args: unknown[]) => RedisClient;
  try {
     
    Redis = (await import("ioredis" as string)).default;
  } catch {
    throw new Error(
      "ioredis is required for Redis KV adapter. Install it with: npm install ioredis"
    );
  }

  const client = config.url
    ? new Redis(config.url)
    : new Redis({
        host: config.host ?? "localhost",
        port: config.port ?? 6379,
        password: config.password,
        db: config.db ?? 0,
        tls: config.tls ? {} : undefined,
        maxRetriesPerRequest: config.maxRetries ?? 3,
        retryStrategy: (times: number) => {
          if (config.maxRetries && times > config.maxRetries) {
            return null;
          }
          return config.retryDelay ?? Math.min(times * 50, 2000);
        },
      });

  return new RedisKVStore(client as unknown as RedisClient, prefix);
};
