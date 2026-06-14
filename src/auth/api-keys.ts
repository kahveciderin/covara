import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";
import type { KVAdapter } from "@/kv/types";

export interface ApiKeyMetadata {
  id: string;
  label?: string;
  userId?: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  scopes?: string[];
}

export interface StoredApiKey extends ApiKeyMetadata {
  hash: string;
}

export interface ApiKeyStore {
  create(record: StoredApiKey): Promise<void>;
  list(filter?: { userId?: string }): Promise<StoredApiKey[]>;
  findById(id: string): Promise<StoredApiKey | null>;
  delete(id: string): Promise<void>;
  touch(id: string, lastUsedAt: Date): Promise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, StoredApiKey>();

  async create(record: StoredApiKey): Promise<void> {
    this.keys.set(record.id, record);
  }

  async list(filter?: { userId?: string }): Promise<StoredApiKey[]> {
    const all = Array.from(this.keys.values());
    if (filter?.userId !== undefined) {
      return all.filter((k) => k.userId === filter.userId);
    }
    return all;
  }

  async findById(id: string): Promise<StoredApiKey | null> {
    return this.keys.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.keys.delete(id);
  }

  async touch(id: string, lastUsedAt: Date): Promise<void> {
    const key = this.keys.get(id);
    if (key) {
      key.lastUsedAt = lastUsedAt;
    }
  }
}

interface SerializedApiKey {
  id: string;
  label?: string;
  userId?: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  scopes?: string[];
  hash: string;
}

const serializeApiKey = (k: StoredApiKey): string =>
  JSON.stringify({
    ...k,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
  } satisfies SerializedApiKey);

const deserializeApiKey = (raw: string): StoredApiKey => {
  const s = JSON.parse(raw) as SerializedApiKey;
  return {
    id: s.id,
    label: s.label,
    userId: s.userId,
    scopes: s.scopes,
    hash: s.hash,
    createdAt: new Date(s.createdAt),
    lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt) : null,
    expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
  };
};

// KV-backed API-key store — works with any KV adapter (memory/redis/durable
// object), so API keys survive restarts and are shared across instances.
export class KVApiKeyStore implements ApiKeyStore {
  private kv: KVAdapter;
  private prefix: string;

  constructor(kv: KVAdapter, prefix = "apikey") {
    this.kv = kv;
    this.prefix = prefix;
  }

  private recordKey(id: string): string {
    return `${this.prefix}:${id}`;
  }
  private allKey(): string {
    return `${this.prefix}:all`;
  }
  private userKey(userId: string): string {
    return `${this.prefix}:user:${userId}`;
  }

  async create(record: StoredApiKey): Promise<void> {
    await this.kv.set(this.recordKey(record.id), serializeApiKey(record));
    await this.kv.sadd(this.allKey(), record.id);
    if (record.userId !== undefined) {
      await this.kv.sadd(this.userKey(record.userId), record.id);
    }
  }

  async list(filter?: { userId?: string }): Promise<StoredApiKey[]> {
    const ids =
      filter?.userId !== undefined
        ? await this.kv.smembers(this.userKey(filter.userId))
        : await this.kv.smembers(this.allKey());
    const out: StoredApiKey[] = [];
    for (const id of ids) {
      const raw = await this.kv.get(this.recordKey(id));
      if (raw) out.push(deserializeApiKey(raw));
    }
    return out;
  }

  async findById(id: string): Promise<StoredApiKey | null> {
    const raw = await this.kv.get(this.recordKey(id));
    return raw ? deserializeApiKey(raw) : null;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.findById(id);
    await this.kv.del(this.recordKey(id));
    await this.kv.srem(this.allKey(), id);
    if (existing?.userId !== undefined) {
      await this.kv.srem(this.userKey(existing.userId), id);
    }
  }

  async touch(id: string, lastUsedAt: Date): Promise<void> {
    const existing = await this.findById(id);
    if (existing) {
      existing.lastUsedAt = lastUsedAt;
      await this.kv.set(this.recordKey(id), serializeApiKey(existing));
    }
  }
}

export const createKVApiKeyStore = (kv: KVAdapter, prefix?: string): KVApiKeyStore =>
  new KVApiKeyStore(kv, prefix);

export interface CreateApiKeyOptions {
  store: ApiKeyStore;
  label?: string;
  userId?: string;
  scopes?: string[];
  expiresAt?: Date | null;
  ttlMs?: number;
  prefix?: string;
  byteLength?: number;
}

export interface CreatedApiKey {
  key: string;
  metadata: ApiKeyMetadata;
}

const generateRawKey = (prefix: string | undefined, byteLength: number): { key: string; id: string } => {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(byteLength).toString("base64url");
  const key = prefix ? `${prefix}_${id}.${secret}` : `${id}.${secret}`;
  return { key, id };
};

const toMetadata = (stored: StoredApiKey): ApiKeyMetadata => ({
  id: stored.id,
  label: stored.label,
  userId: stored.userId,
  createdAt: stored.createdAt,
  lastUsedAt: stored.lastUsedAt ?? null,
  expiresAt: stored.expiresAt ?? null,
  scopes: stored.scopes,
});

export const createApiKey = async (options: CreateApiKeyOptions): Promise<CreatedApiKey> => {
  const { key, id } = generateRawKey(options.prefix, options.byteLength ?? 24);
  const hash = await hashPassword(key);
  const createdAt = new Date();
  const expiresAt =
    options.expiresAt ??
    (options.ttlMs !== undefined ? new Date(createdAt.getTime() + options.ttlMs) : null);

  const stored: StoredApiKey = {
    id,
    label: options.label,
    userId: options.userId,
    scopes: options.scopes,
    createdAt,
    lastUsedAt: null,
    expiresAt,
    hash,
  };

  await options.store.create(stored);
  return { key, metadata: toMetadata(stored) };
};

const parseKeyId = (key: string): string | null => {
  // Format is `[prefix_]id.secret`. Split on the FIRST "." so the base64url
  // secret (which may itself contain "_" or "-") can't corrupt id extraction,
  // then strip an optional `prefix_` segment (the id is hex, no underscores).
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const idPart = key.slice(0, dot);
  const underscore = idPart.lastIndexOf("_");
  const id = underscore >= 0 ? idPart.slice(underscore + 1) : idPart;
  return id.length > 0 ? id : null;
};

export interface VerifyApiKeyResult {
  valid: boolean;
  metadata?: ApiKeyMetadata;
  reason?: "not_found" | "expired" | "mismatch";
}

export const verifyApiKey = async (
  key: string,
  options: { store: ApiKeyStore; updateLastUsed?: boolean; now?: Date }
): Promise<VerifyApiKeyResult> => {
  const id = parseKeyId(key);
  if (!id) return { valid: false, reason: "not_found" };

  const stored = await options.store.findById(id);
  if (!stored) return { valid: false, reason: "not_found" };

  const now = options.now ?? new Date();
  if (stored.expiresAt && stored.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }

  const matches = await verifyPassword(key, stored.hash);
  if (!matches) return { valid: false, reason: "mismatch" };

  if (options.updateLastUsed !== false) {
    await options.store.touch(stored.id, now);
    stored.lastUsedAt = now;
  }

  return { valid: true, metadata: toMetadata(stored) };
};

export const listApiKeys = async (
  options: { store: ApiKeyStore; userId?: string }
): Promise<ApiKeyMetadata[]> => {
  const stored = await options.store.list(
    options.userId !== undefined ? { userId: options.userId } : undefined
  );
  return stored.map(toMetadata);
};

export const revokeApiKey = async (
  id: string,
  options: { store: ApiKeyStore }
): Promise<void> => {
  await options.store.delete(id);
};

export interface RotateApiKeyOptions extends CreateApiKeyOptions {
  id: string;
}

export const rotateApiKey = async (options: RotateApiKeyOptions): Promise<CreatedApiKey> => {
  const existing = await options.store.findById(options.id);
  await options.store.delete(options.id);
  return createApiKey({
    store: options.store,
    label: options.label ?? existing?.label,
    userId: options.userId ?? existing?.userId,
    scopes: options.scopes ?? existing?.scopes,
    expiresAt: options.expiresAt ?? existing?.expiresAt ?? null,
    ttlMs: options.ttlMs,
    prefix: options.prefix,
    byteLength: options.byteLength,
  });
};
