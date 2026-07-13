/**
 * In-Memory KV Store Implementation
 *
 * A full-featured in-memory implementation of the KV adapter interface.
 * Suitable for development, testing, and single-process deployments.
 *
 * Note: This store does NOT persist data across restarts and does NOT
 * share state between processes. Use Redis for production multi-process deployments.
 */

import {
  KVAdapter,
  KVTransaction,
  SetOptions,
  ZRangeOptions,
  ScanOptions,
  ScanResult,
  ScopedSubscription,
} from "./types";

interface StoredValue {
  value: unknown;
  type: "string" | "hash" | "set" | "list" | "zset";
  expiresAt?: number;
}

interface ZSetMember {
  member: string;
  score: number;
}

type SubscriptionCallback = (message: string, channel: string) => void;

export class MemoryKVStore implements KVAdapter {
  private store = new Map<string, StoredValue>();
  private subscriptions = new Map<string, Set<SubscriptionCallback>>();
  private patternSubscriptions = new Map<string, Set<SubscriptionCallback>>();
  private connected = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private prefix: string;

  constructor(prefix = "") {
    this.prefix = prefix;
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  private checkExpiry(key: string): boolean {
    const stored = this.store.get(key);
    if (stored?.expiresAt && Date.now() > stored.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  private getString(key: string): string | null {
    this.checkExpiry(key);
    const stored = this.store.get(key);
    if (!stored || stored.type !== "string") return null;
    return stored.value as string;
  }

  private getHash(key: string): Map<string, string> {
    this.checkExpiry(key);
    const stored = this.store.get(key);
    if (!stored || stored.type !== "hash") return new Map();
    return stored.value as Map<string, string>;
  }

  private getSet(key: string): Set<string> {
    this.checkExpiry(key);
    const stored = this.store.get(key);
    if (!stored || stored.type !== "set") return new Set();
    return stored.value as Set<string>;
  }

  private getList(key: string): string[] {
    this.checkExpiry(key);
    const stored = this.store.get(key);
    if (!stored || stored.type !== "list") return [];
    return stored.value as string[];
  }

  private getZSet(key: string): ZSetMember[] {
    this.checkExpiry(key);
    const stored = this.store.get(key);
    if (!stored || stored.type !== "zset") return [];
    return stored.value as ZSetMember[];
  }

  async connect(): Promise<void> {
    this.connected = true;
    // Start cleanup interval for expired keys
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, stored] of this.store) {
        if (stored.expiresAt && now > stored.expiresAt) {
          this.store.delete(key);
        }
      }
    }, 1000);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
    this.subscriptions.clear();
    this.patternSubscriptions.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // String operations

  async get(key: string): Promise<string | null> {
    return this.getString(this.key(key));
  }

  async set(key: string, value: string, options?: SetOptions): Promise<void> {
    const k = this.key(key);
    this.checkExpiry(k);
    const existing = this.store.get(k);

    if (options?.nx && existing) return;
    if (options?.xx && !existing) return;

    let expiresAt: number | undefined;
    if (options?.ex) {
      expiresAt = Date.now() + options.ex * 1000;
    } else if (options?.px) {
      expiresAt = Date.now() + options.px;
    }

    this.store.set(k, { value, type: "string", expiresAt });
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(this.key(key))) deleted++;
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const k = this.key(key);
      this.checkExpiry(k);
      if (this.store.has(k)) count++;
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  async incrBy(key: string, increment: number): Promise<number> {
    const k = this.key(key);
    const current = this.getString(k);
    const value = (current ? parseInt(current, 10) : 0) + increment;
    const stored = this.store.get(k);
    this.store.set(k, {
      value: String(value),
      type: "string",
      expiresAt: stored?.expiresAt,
    });
    return value;
  }

  async decr(key: string): Promise<number> {
    return this.incrBy(key, -1);
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const k = this.key(key);
    const stored = this.store.get(k);
    if (!stored) return false;
    stored.expiresAt = Date.now() + seconds * 1000;
    return true;
  }

  async ttl(key: string): Promise<number> {
    const k = this.key(key);
    const stored = this.store.get(k);
    if (!stored) return -2;
    if (!stored.expiresAt) return -1;
    const remaining = Math.ceil((stored.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  // Hash operations

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.getHash(this.key(key));
    return hash.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const k = this.key(key);
    let hash = this.getHash(k);
    const isNew = !hash.has(field);

    if (!this.store.has(k) || this.store.get(k)?.type !== "hash") {
      hash = new Map();
      this.store.set(k, { value: hash, type: "hash" });
    } else {
      hash = this.store.get(k)!.value as Map<string, string>;
    }

    hash.set(field, value);
    return isNew ? 1 : 0;
  }

  async hmset(key: string, data: Record<string, string>): Promise<void> {
    const k = this.key(key);
    let hash: Map<string, string>;

    if (!this.store.has(k) || this.store.get(k)?.type !== "hash") {
      hash = new Map();
      this.store.set(k, { value: hash, type: "hash" });
    } else {
      hash = this.store.get(k)!.value as Map<string, string>;
    }

    for (const [field, value] of Object.entries(data)) {
      hash.set(field, value);
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.getHash(this.key(key));
    return Object.fromEntries(hash);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const k = this.key(key);
    const stored = this.store.get(k);
    if (!stored || stored.type !== "hash") return 0;

    const hash = stored.value as Map<string, string>;
    let deleted = 0;
    for (const field of fields) {
      if (hash.delete(field)) deleted++;
    }
    return deleted;
  }

  async hexists(key: string, field: string): Promise<boolean> {
    const hash = this.getHash(this.key(key));
    return hash.has(field);
  }

  async hkeys(key: string): Promise<string[]> {
    const hash = this.getHash(this.key(key));
    return Array.from(hash.keys());
  }

  async hlen(key: string): Promise<number> {
    const hash = this.getHash(this.key(key));
    return hash.size;
  }

  // Set operations

  async sadd(key: string, ...members: string[]): Promise<number> {
    const k = this.key(key);
    let set: Set<string>;

    if (!this.store.has(k) || this.store.get(k)?.type !== "set") {
      set = new Set();
      this.store.set(k, { value: set, type: "set" });
    } else {
      set = this.store.get(k)!.value as Set<string>;
    }

    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.getSet(this.key(key));
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.getSet(this.key(key));
    return Array.from(set);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const set = this.getSet(this.key(key));
    return set.has(member);
  }

  async scard(key: string): Promise<number> {
    const set = this.getSet(this.key(key));
    return set.size;
  }

  // List operations

  async lpush(key: string, ...values: string[]): Promise<number> {
    const k = this.key(key);
    let list: string[];

    if (!this.store.has(k) || this.store.get(k)?.type !== "list") {
      list = [];
      this.store.set(k, { value: list, type: "list" });
    } else {
      list = this.store.get(k)!.value as string[];
    }

    list.unshift(...values.reverse());
    return list.length;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const k = this.key(key);
    let list: string[];

    if (!this.store.has(k) || this.store.get(k)?.type !== "list") {
      list = [];
      this.store.set(k, { value: list, type: "list" });
    } else {
      list = this.store.get(k)!.value as string[];
    }

    list.push(...values);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.getList(this.key(key));
    return list.shift() ?? null;
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.getList(this.key(key));
    return list.pop() ?? null;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.getList(this.key(key));
    const len = list.length;

    // Handle negative indices
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;

    // Redis includes the element at stop index
    return list.slice(s, e + 1);
  }

  async llen(key: string): Promise<number> {
    const list = this.getList(this.key(key));
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const k = this.key(key);
    const stored = this.store.get(k);
    if (!stored || stored.type !== "list") return;

    const list = stored.value as string[];
    const len = list.length;

    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;

    stored.value = list.slice(s, e + 1);
  }

  // Sorted set operations

  async zadd(key: string, score: number, member: string): Promise<number> {
    const k = this.key(key);
    let zset: ZSetMember[];

    if (!this.store.has(k) || this.store.get(k)?.type !== "zset") {
      zset = [];
      this.store.set(k, { value: zset, type: "zset" });
    } else {
      zset = this.store.get(k)!.value as ZSetMember[];
    }

    const existing = zset.findIndex((m) => m.member === member);
    if (existing >= 0) {
      zset[existing].score = score;
      zset.sort((a, b) => a.score - b.score);
      return 0;
    }

    zset.push({ member, score });
    zset.sort((a, b) => a.score - b.score);
    return 1;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const k = this.key(key);
    const stored = this.store.get(k);
    if (!stored || stored.type !== "zset") return 0;

    const zset = stored.value as ZSetMember[];
    let removed = 0;

    for (const member of members) {
      const idx = zset.findIndex((m) => m.member === member);
      if (idx >= 0) {
        zset.splice(idx, 1);
        removed++;
      }
    }
    return removed;
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const zset = this.getZSet(this.key(key));
    const found = zset.find((m) => m.member === member);
    return found?.score ?? null;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.getZSet(this.key(key));
    const len = zset.length;

    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;

    return zset.slice(s, e + 1).map((m) => m.member);
  }

  async zrangebyscore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
    options?: ZRangeOptions
  ): Promise<string[]> {
    const zset = this.getZSet(this.key(key));
    const minScore = min === "-inf" ? -Infinity : min;
    const maxScore = max === "+inf" ? Infinity : max;

    let filtered = zset.filter(
      (m) => m.score >= minScore && m.score <= maxScore
    );

    if (options?.limit) {
      filtered = filtered.slice(
        options.limit.offset,
        options.limit.offset + options.limit.count
      );
    }

    return filtered.map((m) => m.member);
  }

  async zcard(key: string): Promise<number> {
    const zset = this.getZSet(this.key(key));
    return zset.length;
  }

  async zincrby(
    key: string,
    increment: number,
    member: string
  ): Promise<number> {
    const k = this.key(key);
    let zset: ZSetMember[];

    if (!this.store.has(k) || this.store.get(k)?.type !== "zset") {
      zset = [];
      this.store.set(k, { value: zset, type: "zset" });
    } else {
      zset = this.store.get(k)!.value as ZSetMember[];
    }

    const existing = zset.find((m) => m.member === member);
    if (existing) {
      existing.score += increment;
      zset.sort((a, b) => a.score - b.score);
      return existing.score;
    }

    zset.push({ member, score: increment });
    zset.sort((a, b) => a.score - b.score);
    return increment;
  }

  // Key scanning

  async keys(pattern: string): Promise<string[]> {
    const regex = this.patternToRegex(this.key(pattern));
    const result: string[] = [];

    for (const key of this.store.keys()) {
      this.checkExpiry(key);
      if (regex.test(key)) {
        result.push(this.prefix ? key.slice(this.prefix.length + 1) : key);
      }
    }

    return result;
  }

  async scan(cursor: string, options?: ScanOptions): Promise<ScanResult> {
    const allKeys = await this.keys(options?.match ?? "*");
    const start = parseInt(cursor, 10) || 0;
    const count = options?.count ?? 10;
    const end = Math.min(start + count, allKeys.length);

    return {
      cursor: end >= allKeys.length ? "0" : String(end),
      keys: allKeys.slice(start, end),
    };
  }

  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  }

  // Pub/Sub

  async publish(channel: string, message: string): Promise<number> {
    let count = 0;

    // Direct subscriptions
    const callbacks = this.subscriptions.get(channel);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(message, channel);
        count++;
      }
    }

    // Pattern subscriptions
    for (const [pattern, callbacks] of this.patternSubscriptions) {
      const regex = this.patternToRegex(pattern);
      if (regex.test(channel)) {
        for (const callback of callbacks) {
          callback(message, channel);
          count++;
        }
      }
    }

    return count;
  }

  async subscribe(
    channel: string,
    callback: (message: string, channel: string) => void
  ): Promise<void> {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)!.add(callback);
  }

  async psubscribe(
    pattern: string,
    callback: (message: string, channel: string) => void
  ): Promise<void> {
    if (!this.patternSubscriptions.has(pattern)) {
      this.patternSubscriptions.set(pattern, new Set());
    }
    this.patternSubscriptions.get(pattern)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptions.delete(channel);
  }

  async punsubscribe(pattern: string): Promise<void> {
    this.patternSubscriptions.delete(pattern);
  }

  async subscribeScoped(
    channels: string[],
    callback: (message: string, channel: string) => void
  ): Promise<ScopedSubscription> {
    for (const channel of channels) {
      if (!this.subscriptions.has(channel)) {
        this.subscriptions.set(channel, new Set());
      }
      this.subscriptions.get(channel)!.add(callback);
    }
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        for (const channel of channels) {
          const set = this.subscriptions.get(channel);
          if (!set) continue;
          set.delete(callback);
          if (set.size === 0) this.subscriptions.delete(channel);
        }
      },
    };
  }

  // Transactions

  multi(): KVTransaction {
    return new MemoryTransaction(this);
  }

  // Lua scripting (simplified - just for basic atomic operations)

  async eval(
    _script: string,
    _keys: string[],
    _args: string[]
  ): Promise<unknown> {
    // In-memory implementation doesn't support Lua
    // This is a placeholder that just returns null
    // Real Redis implementation will execute actual Lua
    console.warn("Lua scripting not supported in memory KV store");
    return null;
  }

  // Internal method for transaction execution
  async _execCommand(
    cmd: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (cmd) {
      case "get":
        return this.get(args[0] as string);
      case "set":
        await this.set(args[0] as string, args[1] as string, args[2] as SetOptions);
        return "OK";
      case "del":
        return this.del(...(args as string[]));
      case "incr":
        return this.incr(args[0] as string);
      case "hset":
        return this.hset(args[0] as string, args[1] as string, args[2] as string);
      case "hdel":
        return this.hdel(args[0] as string, ...(args.slice(1) as string[]));
      case "sadd":
        return this.sadd(args[0] as string, ...(args.slice(1) as string[]));
      case "srem":
        return this.srem(args[0] as string, ...(args.slice(1) as string[]));
      case "lpush":
        return this.lpush(args[0] as string, ...(args.slice(1) as string[]));
      case "rpush":
        return this.rpush(args[0] as string, ...(args.slice(1) as string[]));
      case "zadd":
        return this.zadd(args[0] as string, args[1] as number, args[2] as string);
      case "zrem":
        return this.zrem(args[0] as string, ...(args.slice(1) as string[]));
      case "expire":
        return this.expire(args[0] as string, args[1] as number);
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }
}

class MemoryTransaction implements KVTransaction {
  private commands: Array<{ cmd: string; args: unknown[] }> = [];
  private store: MemoryKVStore;

  constructor(store: MemoryKVStore) {
    this.store = store;
  }

  get(key: string): KVTransaction {
    this.commands.push({ cmd: "get", args: [key] });
    return this;
  }

  set(key: string, value: string, options?: SetOptions): KVTransaction {
    this.commands.push({ cmd: "set", args: [key, value, options] });
    return this;
  }

  del(...keys: string[]): KVTransaction {
    this.commands.push({ cmd: "del", args: keys });
    return this;
  }

  incr(key: string): KVTransaction {
    this.commands.push({ cmd: "incr", args: [key] });
    return this;
  }

  hset(key: string, field: string, value: string): KVTransaction {
    this.commands.push({ cmd: "hset", args: [key, field, value] });
    return this;
  }

  hdel(key: string, ...fields: string[]): KVTransaction {
    this.commands.push({ cmd: "hdel", args: [key, ...fields] });
    return this;
  }

  sadd(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ cmd: "sadd", args: [key, ...members] });
    return this;
  }

  srem(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ cmd: "srem", args: [key, ...members] });
    return this;
  }

  lpush(key: string, ...values: string[]): KVTransaction {
    this.commands.push({ cmd: "lpush", args: [key, ...values] });
    return this;
  }

  rpush(key: string, ...values: string[]): KVTransaction {
    this.commands.push({ cmd: "rpush", args: [key, ...values] });
    return this;
  }

  zadd(key: string, score: number, member: string): KVTransaction {
    this.commands.push({ cmd: "zadd", args: [key, score, member] });
    return this;
  }

  zrem(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ cmd: "zrem", args: [key, ...members] });
    return this;
  }

  expire(key: string, seconds: number): KVTransaction {
    this.commands.push({ cmd: "expire", args: [key, seconds] });
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const { cmd, args } of this.commands) {
      results.push(await this.store._execCommand(cmd, args));
    }
    this.commands = [];
    return results;
  }

  discard(): void {
    this.commands = [];
  }
}

export const createMemoryKV = (prefix?: string): KVAdapter => {
  return new MemoryKVStore(prefix);
};
