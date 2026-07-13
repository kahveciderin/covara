/**
 * Cloudflare Durable Object KV Store Implementation
 *
 * Backs the KV adapter interface with a single Durable Object instance.
 * The module is structured in three layers:
 *
 * 1. DurableKVEngine - executes KV operations against Durable Object storage.
 *    Collections are stored one storage entry per member because Durable
 *    Object storage caps individual values at 128KB.
 * 2. CovaraKVDurableObject - the Durable Object class. Users re-export it
 *    from their worker entry and bind it in wrangler.toml. Handles batched
 *    commands over POST /batch and pub/sub over hibernating WebSockets.
 * 3. DurableObjectKVStore - the KVAdapter implementation that talks to the
 *    Durable Object via its stub.
 *
 * This module deliberately has zero Cloudflare imports so it stays
 * compilable and testable under Node. Cloudflare-specific globals
 * (WebSocketPair) are resolved at runtime via globalThis.
 */

import {
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  KVAdapter,
  KVTransaction,
  ScanOptions,
  ScanResult,
  ScopedSubscription,
  SetOptions,
  ZRangeOptions,
} from "./types";

export type { DurableObjectNamespaceLike, DurableObjectStubLike } from "./types";

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  addEventListener?(
    type: "message" | "close",
    handler: (event: { data?: unknown }) => void
  ): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket(ws: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
}

export interface DurableObjectKVOptions {
  name?: string;
  prefix?: string;
  reconnectDelay?: (attempt: number) => number;
}

interface BatchCommand {
  op: string;
  args: unknown[];
}

interface BatchRequestBody {
  commands: BatchCommand[];
  stopOnError?: boolean;
}

type BatchResult = { ok: true; value: unknown } | { ok: false; error: string };

type SubscriptionCallback = (message: string, channel: string) => void;

interface StringEntry {
  v: string;
  exp?: number;
}

type CollectionType = "hash" | "set" | "list" | "zset";

interface MetaEntry {
  type: CollectionType;
  exp?: number;
  head?: number;
  tail?: number;
}

interface ZSetMember {
  member: string;
  score: number;
}

// NUL never appears in real keys, unlike spaces or colons
const SEP = "\u0000";

const COLLECTION_PREFIX: Record<CollectionType, string> = {
  hash: "h",
  set: "e",
  list: "l",
  zset: "z",
};

const LIST_INDEX_BASE = 2 ** 42;

const padListIndex = (position: number): string =>
  String(LIST_INDEX_BASE + position).padStart(14, "0");

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
};

export class DurableKVEngine {
  private storage: DurableObjectStorageLike;

  constructor(storage: DurableObjectStorageLike) {
    this.storage = storage;
  }

  private stringKey(key: string): string {
    return `s${SEP}${key}`;
  }

  private metaKey(key: string): string {
    return `m${SEP}${key}`;
  }

  private memberKey(type: CollectionType, key: string, member: string): string {
    return `${COLLECTION_PREFIX[type]}${SEP}${key}${SEP}${member}`;
  }

  private memberPrefix(type: CollectionType, key: string): string {
    return `${COLLECTION_PREFIX[type]}${SEP}${key}${SEP}`;
  }

  private async deleteMembers(type: CollectionType, key: string): Promise<void> {
    const entries = await this.storage.list({
      prefix: this.memberPrefix(type, key),
    });
    for (const storageKey of entries.keys()) {
      await this.storage.delete(storageKey);
    }
  }

  private async deleteLogicalKey(key: string): Promise<boolean> {
    let deleted = false;
    if (await this.storage.delete(this.stringKey(key))) {
      deleted = true;
    }
    const meta = await this.storage.get<MetaEntry>(this.metaKey(key));
    if (meta) {
      await this.deleteMembers(meta.type, key);
      await this.storage.delete(this.metaKey(key));
      deleted = true;
    }
    return deleted;
  }

  private async readString(key: string): Promise<StringEntry | null> {
    const entry = await this.storage.get<StringEntry>(this.stringKey(key));
    if (!entry) return null;
    if (entry.exp !== undefined && Date.now() > entry.exp) {
      await this.storage.delete(this.stringKey(key));
      return null;
    }
    return entry;
  }

  private async readMeta(key: string): Promise<MetaEntry | null> {
    const meta = await this.storage.get<MetaEntry>(this.metaKey(key));
    if (!meta) return null;
    if (meta.exp !== undefined && Date.now() > meta.exp) {
      await this.deleteMembers(meta.type, key);
      await this.storage.delete(this.metaKey(key));
      return null;
    }
    return meta;
  }

  private async readMetaOfType(
    key: string,
    type: CollectionType
  ): Promise<MetaEntry | null> {
    const meta = await this.readMeta(key);
    return meta?.type === type ? meta : null;
  }

  private async prepareCollection(
    key: string,
    type: CollectionType
  ): Promise<MetaEntry> {
    const existing = await this.readMeta(key);
    if (existing?.type === type) return existing;
    await this.deleteLogicalKey(key);
    const meta: MetaEntry = type === "list" ? { type, head: 0, tail: 0 } : { type };
    await this.storage.put(this.metaKey(key), meta);
    return meta;
  }

  async get(key: string): Promise<string | null> {
    return (await this.readString(key))?.v ?? null;
  }

  async set(key: string, value: string, options?: SetOptions): Promise<string> {
    const stringEntry = await this.readString(key);
    const meta = await this.readMeta(key);
    const exists = stringEntry !== null || meta !== null;

    if (options?.nx && exists) return "OK";
    if (options?.xx && !exists) return "OK";

    let exp: number | undefined;
    if (options?.ex) {
      exp = Date.now() + options.ex * 1000;
    } else if (options?.px) {
      exp = Date.now() + options.px;
    }

    if (meta) {
      await this.deleteLogicalKey(key);
    }
    const entry: StringEntry = exp === undefined ? { v: value } : { v: value, exp };
    await this.storage.put(this.stringKey(key), entry);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (await this.deleteLogicalKey(key)) deleted++;
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if ((await this.readString(key)) !== null || (await this.readMeta(key)) !== null) {
        count++;
      }
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  async incrBy(key: string, increment: number): Promise<number> {
    const stringEntry = await this.readString(key);
    let exp = stringEntry?.exp;
    if (!stringEntry) {
      const meta = await this.readMeta(key);
      if (meta) {
        exp = meta.exp;
        await this.deleteLogicalKey(key);
      }
    }
    const current = stringEntry ? parseInt(stringEntry.v, 10) : 0;
    const value = current + increment;
    const entry: StringEntry =
      exp === undefined ? { v: String(value) } : { v: String(value), exp };
    await this.storage.put(this.stringKey(key), entry);
    return value;
  }

  async decr(key: string): Promise<number> {
    return this.incrBy(key, -1);
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const exp = Date.now() + seconds * 1000;
    const stringEntry = await this.readString(key);
    if (stringEntry) {
      await this.storage.put(this.stringKey(key), { ...stringEntry, exp });
      return true;
    }
    const meta = await this.readMeta(key);
    if (meta) {
      await this.storage.put(this.metaKey(key), { ...meta, exp });
      return true;
    }
    return false;
  }

  async ttl(key: string): Promise<number> {
    const stringEntry = await this.readString(key);
    const entry = stringEntry ?? (await this.readMeta(key));
    if (!entry) return -2;
    if (entry.exp === undefined) return -1;
    const remaining = Math.ceil((entry.exp - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const meta = await this.readMetaOfType(key, "hash");
    if (!meta) return null;
    const value = await this.storage.get<string>(this.memberKey("hash", key, field));
    return value ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    await this.prepareCollection(key, "hash");
    const fieldKey = this.memberKey("hash", key, field);
    const existing = await this.storage.get<string>(fieldKey);
    await this.storage.put(fieldKey, value);
    return existing === undefined ? 1 : 0;
  }

  async hmset(key: string, data: Record<string, string>): Promise<void> {
    await this.prepareCollection(key, "hash");
    for (const [field, value] of Object.entries(data)) {
      await this.storage.put(this.memberKey("hash", key, field), value);
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const meta = await this.readMetaOfType(key, "hash");
    if (!meta) return {};
    const prefix = this.memberPrefix("hash", key);
    const entries = await this.storage.list<string>({ prefix });
    const result: Record<string, string> = {};
    for (const [storageKey, value] of entries) {
      result[storageKey.slice(prefix.length)] = value;
    }
    return result;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const meta = await this.readMetaOfType(key, "hash");
    if (!meta) return 0;
    let deleted = 0;
    for (const field of fields) {
      if (await this.storage.delete(this.memberKey("hash", key, field))) {
        deleted++;
      }
    }
    return deleted;
  }

  async hexists(key: string, field: string): Promise<boolean> {
    const meta = await this.readMetaOfType(key, "hash");
    if (!meta) return false;
    const value = await this.storage.get<string>(this.memberKey("hash", key, field));
    return value !== undefined;
  }

  async hkeys(key: string): Promise<string[]> {
    return Object.keys(await this.hgetall(key));
  }

  async hlen(key: string): Promise<number> {
    return (await this.hkeys(key)).length;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    await this.prepareCollection(key, "set");
    let added = 0;
    for (const member of members) {
      const memberKey = this.memberKey("set", key, member);
      const existing = await this.storage.get<number>(memberKey);
      if (existing === undefined) {
        await this.storage.put(memberKey, 1);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const meta = await this.readMetaOfType(key, "set");
    if (!meta) return 0;
    let removed = 0;
    for (const member of members) {
      if (await this.storage.delete(this.memberKey("set", key, member))) {
        removed++;
      }
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const meta = await this.readMetaOfType(key, "set");
    if (!meta) return [];
    const prefix = this.memberPrefix("set", key);
    const entries = await this.storage.list({ prefix });
    return [...entries.keys()].map((storageKey) => storageKey.slice(prefix.length));
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const meta = await this.readMetaOfType(key, "set");
    if (!meta) return false;
    const value = await this.storage.get<number>(this.memberKey("set", key, member));
    return value !== undefined;
  }

  async scard(key: string): Promise<number> {
    return (await this.smembers(key)).length;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const meta = await this.prepareCollection(key, "list");
    let head = meta.head ?? 0;
    const tail = meta.tail ?? 0;
    for (const value of values) {
      head -= 1;
      await this.storage.put(this.memberKey("list", key, padListIndex(head)), value);
    }
    await this.storage.put(this.metaKey(key), { ...meta, head, tail });
    return tail - head;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const meta = await this.prepareCollection(key, "list");
    const head = meta.head ?? 0;
    let tail = meta.tail ?? 0;
    for (const value of values) {
      await this.storage.put(this.memberKey("list", key, padListIndex(tail)), value);
      tail += 1;
    }
    await this.storage.put(this.metaKey(key), { ...meta, head, tail });
    return tail - head;
  }

  async lpop(key: string): Promise<string | null> {
    const meta = await this.readMetaOfType(key, "list");
    if (!meta) return null;
    const head = meta.head ?? 0;
    const tail = meta.tail ?? 0;
    if (head >= tail) return null;
    const storageKey = this.memberKey("list", key, padListIndex(head));
    const value = (await this.storage.get<string>(storageKey)) ?? null;
    await this.storage.delete(storageKey);
    await this.storage.put(this.metaKey(key), { ...meta, head: head + 1 });
    return value;
  }

  async rpop(key: string): Promise<string | null> {
    const meta = await this.readMetaOfType(key, "list");
    if (!meta) return null;
    const head = meta.head ?? 0;
    const tail = meta.tail ?? 0;
    if (head >= tail) return null;
    const storageKey = this.memberKey("list", key, padListIndex(tail - 1));
    const value = (await this.storage.get<string>(storageKey)) ?? null;
    await this.storage.delete(storageKey);
    await this.storage.put(this.metaKey(key), { ...meta, tail: tail - 1 });
    return value;
  }

  private async loadList(key: string): Promise<string[]> {
    const meta = await this.readMetaOfType(key, "list");
    if (!meta) return [];
    const entries = await this.storage.list<string>({
      prefix: this.memberPrefix("list", key),
    });
    return [...entries.values()];
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = await this.loadList(key);
    const len = list.length;

    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;

    return list.slice(s, e + 1);
  }

  async llen(key: string): Promise<number> {
    const meta = await this.readMetaOfType(key, "list");
    if (!meta) return 0;
    return (meta.tail ?? 0) - (meta.head ?? 0);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const meta = await this.readMetaOfType(key, "list");
    if (!meta) return;
    const entries = await this.storage.list<string>({
      prefix: this.memberPrefix("list", key),
    });
    const storageKeys = [...entries.keys()];
    const len = storageKeys.length;

    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    const keepFrom = Math.max(s, 0);
    const keepTo = Math.min(e, len - 1);

    for (let i = 0; i < len; i++) {
      if (i < keepFrom || i > keepTo) {
        await this.storage.delete(storageKeys[i]);
      }
    }

    const head = meta.head ?? 0;
    if (keepFrom > keepTo) {
      await this.storage.put(this.metaKey(key), { ...meta, head: 0, tail: 0 });
    } else {
      await this.storage.put(this.metaKey(key), {
        ...meta,
        head: head + keepFrom,
        tail: head + keepTo + 1,
      });
    }
  }

  private async loadZSet(key: string): Promise<ZSetMember[]> {
    const meta = await this.readMetaOfType(key, "zset");
    if (!meta) return [];
    const prefix = this.memberPrefix("zset", key);
    const entries = await this.storage.list<number>({ prefix });
    const members = [...entries].map(([storageKey, score]) => ({
      member: storageKey.slice(prefix.length),
      score,
    }));
    members.sort((a, b) => a.score - b.score);
    return members;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    await this.prepareCollection(key, "zset");
    const memberKey = this.memberKey("zset", key, member);
    const existing = await this.storage.get<number>(memberKey);
    await this.storage.put(memberKey, score);
    return existing === undefined ? 1 : 0;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const meta = await this.readMetaOfType(key, "zset");
    if (!meta) return 0;
    let removed = 0;
    for (const member of members) {
      if (await this.storage.delete(this.memberKey("zset", key, member))) {
        removed++;
      }
    }
    return removed;
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const meta = await this.readMetaOfType(key, "zset");
    if (!meta) return null;
    const score = await this.storage.get<number>(this.memberKey("zset", key, member));
    return score ?? null;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = await this.loadZSet(key);
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
    const zset = await this.loadZSet(key);
    const minScore = min === "-inf" ? -Infinity : min;
    const maxScore = max === "+inf" ? Infinity : max;

    let filtered = zset.filter((m) => m.score >= minScore && m.score <= maxScore);

    if (options?.limit) {
      filtered = filtered.slice(
        options.limit.offset,
        options.limit.offset + options.limit.count
      );
    }

    return filtered.map((m) => m.member);
  }

  async zcard(key: string): Promise<number> {
    return (await this.loadZSet(key)).length;
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    await this.prepareCollection(key, "zset");
    const memberKey = this.memberKey("zset", key, member);
    const existing = await this.storage.get<number>(memberKey);
    const score = (existing ?? 0) + increment;
    await this.storage.put(memberKey, score);
    return score;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = globToRegex(pattern);
    const result: string[] = [];

    const strings = await this.storage.list<StringEntry>({ prefix: `s${SEP}` });
    for (const [storageKey, entry] of strings) {
      const key = storageKey.slice(2);
      if (entry.exp !== undefined && Date.now() > entry.exp) {
        await this.storage.delete(storageKey);
        continue;
      }
      if (regex.test(key)) result.push(key);
    }

    const metas = await this.storage.list<MetaEntry>({ prefix: `m${SEP}` });
    for (const [storageKey, meta] of metas) {
      const key = storageKey.slice(2);
      if (meta.exp !== undefined && Date.now() > meta.exp) {
        await this.deleteMembers(meta.type, key);
        await this.storage.delete(storageKey);
        continue;
      }
      if (regex.test(key)) result.push(key);
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
}

const ENGINE_OPS = new Set([
  "get",
  "set",
  "del",
  "exists",
  "incr",
  "incrBy",
  "decr",
  "expire",
  "ttl",
  "hget",
  "hset",
  "hmset",
  "hgetall",
  "hdel",
  "hexists",
  "hkeys",
  "hlen",
  "sadd",
  "srem",
  "smembers",
  "sismember",
  "scard",
  "lpush",
  "rpush",
  "lpop",
  "rpop",
  "lrange",
  "llen",
  "ltrim",
  "zadd",
  "zrem",
  "zscore",
  "zrange",
  "zrangebyscore",
  "zcard",
  "zincrby",
  "keys",
  "scan",
]);

const parseChannelList = (raw: string | null): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
};

const readAttachmentPatterns = (socket: WebSocketLike): string[] => {
  try {
    const attachment = socket.deserializeAttachment?.();
    if (
      attachment &&
      typeof attachment === "object" &&
      Array.isArray((attachment as { patterns?: unknown }).patterns)
    ) {
      return (attachment as { patterns: string[] }).patterns;
    }
  } catch {
    // sockets without an attachment have no patterns
  }
  return [];
};

const createWebSocketResponse = (client: WebSocketLike): Response => {
  const init = { status: 101, webSocket: client } as ResponseInit;
  try {
    // workerd accepts status 101 with a webSocket; Node's Response does not,
    // so fall back to a structurally compatible object for non-CF runtimes
    return new Response(null, init);
  } catch {
    return { status: 101, ok: false, webSocket: client } as unknown as Response;
  }
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class CovaraKVDurableObject {
  private state: DurableObjectStateLike;
  private engine: DurableKVEngine;

  constructor(state: DurableObjectStateLike) {
    this.state = state;
    this.engine = new DurableKVEngine(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/batch") {
      return this.handleBatch(request);
    }

    if (url.pathname === "/subscribe") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 426 });
      }
      return this.handleSubscribe(url);
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketClose(): Promise<void> {
    // hibernation API shape; subscriber cleanup is handled by the runtime
  }

  async webSocketError(): Promise<void> {
    // hibernation API shape
  }

  private async handleBatch(request: Request): Promise<Response> {
    let body: BatchRequestBody;
    try {
      body = (await request.json()) as BatchRequestBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    if (!Array.isArray(body?.commands)) {
      return jsonResponse({ error: "commands array required" }, 400);
    }

    const results: BatchResult[] = [];
    for (const command of body.commands) {
      try {
        const value = await this.runCommand(command.op, command.args ?? []);
        results.push({ ok: true, value: value === undefined ? null : value });
      } catch (error) {
        results.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (body.stopOnError) break;
      }
    }

    return jsonResponse({ results }, 200);
  }

  private runCommand(op: string, args: unknown[]): Promise<unknown> | unknown {
    if (op === "publish") {
      return this.publish(String(args[0]), String(args[1]));
    }
    if (!ENGINE_OPS.has(op)) {
      throw new Error(`Unknown command: ${op}`);
    }
    const method = (
      this.engine as unknown as Record<string, (...callArgs: unknown[]) => Promise<unknown>>
    )[op];
    return method.apply(this.engine, args);
  }

  private handleSubscribe(url: URL): Response {
    const pairConstructor = (
      globalThis as { WebSocketPair?: new () => Record<string, WebSocketLike> }
    ).WebSocketPair;
    if (!pairConstructor) {
      return new Response("WebSocketPair is not available in this runtime", {
        status: 500,
      });
    }

    const pair = new pairConstructor();
    const client = pair["0"];
    const server = pair["1"];

    const channels = parseChannelList(url.searchParams.get("channels"));
    const patterns = parseChannelList(url.searchParams.get("patterns"));

    this.state.acceptWebSocket(server, channels);
    server.serializeAttachment?.({ patterns });

    return createWebSocketResponse(client);
  }

  private publish(channel: string, message: string): number {
    const targets = new Set<WebSocketLike>(this.state.getWebSockets(channel));
    for (const socket of this.state.getWebSockets()) {
      if (targets.has(socket)) continue;
      const patterns = readAttachmentPatterns(socket);
      if (patterns.some((pattern) => globToRegex(pattern).test(channel))) {
        targets.add(socket);
      }
    }

    const payload = JSON.stringify({ channel, message });
    let delivered = 0;
    for (const socket of targets) {
      try {
        socket.send(payload);
        delivered++;
      } catch {
        // skip sockets that fail to deliver
      }
    }
    return delivered;
  }
}

const defaultReconnectDelay = (attempt: number): number =>
  Math.min(250 * 2 ** attempt, 5000);

// A Durable Object stub is a request-scoped I/O object on Cloudflare Workers:
// creating it in one request and calling `.fetch()` in a later request throws
// "Cannot perform I/O on behalf of a different request" (OutgoingFactory). The
// stub must therefore be derived fresh in the context of each operation. The
// store holds a resolver (over the stable namespace binding) rather than a
// cached stub. A raw stub is still accepted for back-compat but should not be
// cached across requests on Workers.
export type DurableObjectStubResolver = () => DurableObjectStubLike;

export class DurableObjectKVStore implements KVAdapter {
  private getStub: DurableObjectStubResolver;
  private prefix: string;
  private connected = false;
  private channelCallbacks = new Map<string, Set<SubscriptionCallback>>();
  private patternCallbacks = new Map<string, Set<SubscriptionCallback>>();
  private socket: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: (attempt: number) => number;

  constructor(
    stub: DurableObjectStubLike | DurableObjectStubResolver,
    options?: { prefix?: string; reconnectDelay?: (attempt: number) => number }
  ) {
    this.getStub = typeof stub === "function" ? stub : () => stub;
    this.prefix = options?.prefix ?? "";
    this.reconnectDelay = options?.reconnectDelay ?? defaultReconnectDelay;
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  private stripPrefix(key: string): string {
    return this.prefix ? key.slice(this.prefix.length + 1) : key;
  }

  private async execBatch(
    commands: BatchCommand[],
    stopOnError = false
  ): Promise<unknown[]> {
    const response = await this.getStub().fetch("https://covara-kv/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands, stopOnError }),
    });
    if (!response.ok) {
      throw new Error(
        `Durable Object KV request failed with status ${response.status}`
      );
    }
    const body = (await response.json()) as { results: BatchResult[] };
    return body.results.map((result) => {
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
  }

  private async call(op: string, ...args: unknown[]): Promise<unknown> {
    while (args.length > 0 && args[args.length - 1] === undefined) {
      args.pop();
    }
    const [value] = await this.execBatch([{ op, args }]);
    return value;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.channelCallbacks.clear();
    this.patternCallbacks.clear();
    this.clearReconnectTimer();
    this.closeSocket();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async get(key: string): Promise<string | null> {
    return (await this.call("get", this.key(key))) as string | null;
  }

  async set(key: string, value: string, options?: SetOptions): Promise<void> {
    await this.call("set", this.key(key), value, options);
  }

  async del(...keys: string[]): Promise<number> {
    return (await this.call("del", ...keys.map((key) => this.key(key)))) as number;
  }

  async exists(...keys: string[]): Promise<number> {
    return (await this.call("exists", ...keys.map((key) => this.key(key)))) as number;
  }

  async incr(key: string): Promise<number> {
    return (await this.call("incr", this.key(key))) as number;
  }

  async incrBy(key: string, increment: number): Promise<number> {
    return (await this.call("incrBy", this.key(key), increment)) as number;
  }

  async decr(key: string): Promise<number> {
    return (await this.call("decr", this.key(key))) as number;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    return (await this.call("expire", this.key(key), seconds)) as boolean;
  }

  async ttl(key: string): Promise<number> {
    return (await this.call("ttl", this.key(key))) as number;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return (await this.call("hget", this.key(key), field)) as string | null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return (await this.call("hset", this.key(key), field, value)) as number;
  }

  async hmset(key: string, data: Record<string, string>): Promise<void> {
    await this.call("hmset", this.key(key), data);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return (await this.call("hgetall", this.key(key))) as Record<string, string>;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return (await this.call("hdel", this.key(key), ...fields)) as number;
  }

  async hexists(key: string, field: string): Promise<boolean> {
    return (await this.call("hexists", this.key(key), field)) as boolean;
  }

  async hkeys(key: string): Promise<string[]> {
    return (await this.call("hkeys", this.key(key))) as string[];
  }

  async hlen(key: string): Promise<number> {
    return (await this.call("hlen", this.key(key))) as number;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return (await this.call("sadd", this.key(key), ...members)) as number;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return (await this.call("srem", this.key(key), ...members)) as number;
  }

  async smembers(key: string): Promise<string[]> {
    return (await this.call("smembers", this.key(key))) as string[];
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return (await this.call("sismember", this.key(key), member)) as boolean;
  }

  async scard(key: string): Promise<number> {
    return (await this.call("scard", this.key(key))) as number;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return (await this.call("lpush", this.key(key), ...values)) as number;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return (await this.call("rpush", this.key(key), ...values)) as number;
  }

  async lpop(key: string): Promise<string | null> {
    return (await this.call("lpop", this.key(key))) as string | null;
  }

  async rpop(key: string): Promise<string | null> {
    return (await this.call("rpop", this.key(key))) as string | null;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return (await this.call("lrange", this.key(key), start, stop)) as string[];
  }

  async llen(key: string): Promise<number> {
    return (await this.call("llen", this.key(key))) as number;
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.call("ltrim", this.key(key), start, stop);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return (await this.call("zadd", this.key(key), score, member)) as number;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return (await this.call("zrem", this.key(key), ...members)) as number;
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return (await this.call("zscore", this.key(key), member)) as number | null;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return (await this.call("zrange", this.key(key), start, stop)) as string[];
  }

  async zrangebyscore(
    key: string,
    min: number | "-inf",
    max: number | "+inf",
    options?: ZRangeOptions
  ): Promise<string[]> {
    return (await this.call(
      "zrangebyscore",
      this.key(key),
      min,
      max,
      options
    )) as string[];
  }

  async zcard(key: string): Promise<number> {
    return (await this.call("zcard", this.key(key))) as number;
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    return (await this.call("zincrby", this.key(key), increment, member)) as number;
  }

  async keys(pattern: string): Promise<string[]> {
    const raw = (await this.call("keys", this.key(pattern))) as string[];
    return raw.map((key) => this.stripPrefix(key));
  }

  async scan(cursor: string, options?: ScanOptions): Promise<ScanResult> {
    const raw = (await this.call("scan", cursor, {
      ...options,
      match: this.key(options?.match ?? "*"),
    })) as ScanResult;
    return {
      cursor: raw.cursor,
      keys: raw.keys.map((key) => this.stripPrefix(key)),
    };
  }

  async publish(channel: string, message: string): Promise<number> {
    return (await this.call("publish", channel, message)) as number;
  }

  // Dedicated subscribe connection for these channels, isolated from the shared
  // socket. Each call opens its own WebSocket in the CURRENT request's context —
  // essential on Workers, where a subscribe socket is request-scoped: an SSE
  // stream owns its own fan-out socket for its lifetime, so closing one stream
  // never orphans another's. Reconnects within its own lifetime; close() tears
  // only this connection down.
  async subscribeScoped(
    channels: string[],
    callback: SubscriptionCallback
  ): Promise<ScopedSubscription> {
    let closed = false;
    let socket: WebSocketLike | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = this.reconnectDelay(attempts);
      attempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void open().catch(() => scheduleReconnect());
      }, delay);
    };

    const open = async (): Promise<void> => {
      if (closed) return;
      const params = new URLSearchParams();
      params.set("channels", channels.map(encodeURIComponent).join(","));
      const response = await this.getStub().fetch(
        `https://covara-kv/subscribe?${params.toString()}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = (response as unknown as { webSocket?: WebSocketLike }).webSocket;
      if (!ws) {
        throw new Error("Durable Object did not return a WebSocket");
      }
      ws.accept?.();
      ws.addEventListener?.("message", (event) => {
        if (closed) return;
        let parsed: { channel?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed.channel === "string" && typeof parsed.message === "string") {
          callback(parsed.message, parsed.channel);
        }
      });
      ws.addEventListener?.("close", () => {
        if (closed || ws !== socket) return;
        socket = null;
        scheduleReconnect();
      });
      socket = ws;
      attempts = 0;
    };

    await open();

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        clearTimer();
        const ws = socket;
        socket = null;
        ws?.close();
      },
    };
  }

  async subscribe(channel: string, callback: SubscriptionCallback): Promise<void> {
    const callbacks = this.channelCallbacks.get(channel);
    if (callbacks) {
      callbacks.add(callback);
      return;
    }
    this.channelCallbacks.set(channel, new Set([callback]));
    await this.refreshSocket();
  }

  async psubscribe(pattern: string, callback: SubscriptionCallback): Promise<void> {
    const callbacks = this.patternCallbacks.get(pattern);
    if (callbacks) {
      callbacks.add(callback);
      return;
    }
    this.patternCallbacks.set(pattern, new Set([callback]));
    await this.refreshSocket();
  }

  async unsubscribe(channel: string): Promise<void> {
    if (!this.channelCallbacks.delete(channel)) return;
    await this.refreshSocket();
  }

  async punsubscribe(pattern: string): Promise<void> {
    if (!this.patternCallbacks.delete(pattern)) return;
    await this.refreshSocket();
  }

  multi(): KVTransaction {
    return new DurableObjectTransaction(
      (commands) => this.execBatch(commands, true),
      (key) => this.key(key)
    );
  }

  async eval(_script: string, _keys: string[], _args: string[]): Promise<unknown> {
    console.warn("Lua scripting not supported in Durable Object KV store");
    return null;
  }

  private async refreshSocket(): Promise<void> {
    this.clearReconnectTimer();

    if (this.channelCallbacks.size === 0 && this.patternCallbacks.size === 0) {
      this.closeSocket();
      return;
    }

    const params = new URLSearchParams();
    const channels = [...this.channelCallbacks.keys()];
    const patterns = [...this.patternCallbacks.keys()];
    if (channels.length > 0) {
      params.set("channels", channels.map(encodeURIComponent).join(","));
    }
    if (patterns.length > 0) {
      params.set("patterns", patterns.map(encodeURIComponent).join(","));
    }

    const response = await this.getStub().fetch(
      `https://covara-kv/subscribe?${params.toString()}`,
      { headers: { Upgrade: "websocket" } }
    );
    const socket = (response as unknown as { webSocket?: WebSocketLike }).webSocket;
    if (!socket) {
      throw new Error("Durable Object did not return a WebSocket");
    }

    socket.accept?.();
    socket.addEventListener?.("message", (event) => this.dispatchMessage(event.data));
    socket.addEventListener?.("close", () => this.handleSocketClose(socket));

    const previous = this.socket;
    this.socket = socket;
    this.reconnectAttempts = 0;
    previous?.close();
  }

  private dispatchMessage(data: unknown): void {
    let event: { channel?: unknown; message?: unknown };
    try {
      event = JSON.parse(String(data)) as { channel?: unknown; message?: unknown };
    } catch {
      return;
    }
    if (typeof event.channel !== "string" || typeof event.message !== "string") {
      return;
    }
    const channel = event.channel;
    const message = event.message;

    const exact = this.channelCallbacks.get(channel);
    if (exact) {
      for (const callback of exact) {
        callback(message, channel);
      }
    }

    for (const [pattern, callbacks] of this.patternCallbacks) {
      if (!globToRegex(pattern).test(channel)) continue;
      for (const callback of callbacks) {
        callback(message, channel);
      }
    }
  }

  private handleSocketClose(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.channelCallbacks.size === 0 && this.patternCallbacks.size === 0) {
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refreshSocket().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

class DurableObjectTransaction implements KVTransaction {
  private commands: BatchCommand[] = [];
  private execBatch: (commands: BatchCommand[]) => Promise<unknown[]>;
  private prefixKey: (key: string) => string;

  constructor(
    execBatch: (commands: BatchCommand[]) => Promise<unknown[]>,
    prefixKey: (key: string) => string
  ) {
    this.execBatch = execBatch;
    this.prefixKey = prefixKey;
  }

  get(key: string): KVTransaction {
    this.commands.push({ op: "get", args: [this.prefixKey(key)] });
    return this;
  }

  set(key: string, value: string, options?: SetOptions): KVTransaction {
    const args: unknown[] = [this.prefixKey(key), value];
    if (options !== undefined) args.push(options);
    this.commands.push({ op: "set", args });
    return this;
  }

  del(...keys: string[]): KVTransaction {
    this.commands.push({ op: "del", args: keys.map((key) => this.prefixKey(key)) });
    return this;
  }

  incr(key: string): KVTransaction {
    this.commands.push({ op: "incr", args: [this.prefixKey(key)] });
    return this;
  }

  hset(key: string, field: string, value: string): KVTransaction {
    this.commands.push({ op: "hset", args: [this.prefixKey(key), field, value] });
    return this;
  }

  hdel(key: string, ...fields: string[]): KVTransaction {
    this.commands.push({ op: "hdel", args: [this.prefixKey(key), ...fields] });
    return this;
  }

  sadd(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ op: "sadd", args: [this.prefixKey(key), ...members] });
    return this;
  }

  srem(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ op: "srem", args: [this.prefixKey(key), ...members] });
    return this;
  }

  lpush(key: string, ...values: string[]): KVTransaction {
    this.commands.push({ op: "lpush", args: [this.prefixKey(key), ...values] });
    return this;
  }

  rpush(key: string, ...values: string[]): KVTransaction {
    this.commands.push({ op: "rpush", args: [this.prefixKey(key), ...values] });
    return this;
  }

  zadd(key: string, score: number, member: string): KVTransaction {
    this.commands.push({ op: "zadd", args: [this.prefixKey(key), score, member] });
    return this;
  }

  zrem(key: string, ...members: string[]): KVTransaction {
    this.commands.push({ op: "zrem", args: [this.prefixKey(key), ...members] });
    return this;
  }

  expire(key: string, seconds: number): KVTransaction {
    this.commands.push({ op: "expire", args: [this.prefixKey(key), seconds] });
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results = await this.execBatch(this.commands);
    this.commands = [];
    return results;
  }

  discard(): void {
    this.commands = [];
  }
}

export const createDurableObjectKV = (
  namespace: DurableObjectNamespaceLike,
  options?: DurableObjectKVOptions
): KVAdapter => {
  const name = options?.name ?? "covara-kv";
  // Derive the stub per operation. The namespace binding is stable across
  // requests; `idFromName` is a pure hash and `get` allocates a stub with no
  // I/O — the request-scoped part is the `.fetch()` on the stub, which now runs
  // in the calling request's context. Caching the stub here was the cause of the
  // cross-request OutgoingFactory errors on Workers.
  const resolveStub = () => namespace.get(namespace.idFromName(name));
  return new DurableObjectKVStore(resolveStub, {
    prefix: options?.prefix,
    reconnectDelay: options?.reconnectDelay,
  });
};
