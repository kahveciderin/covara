import type { KVAdapter } from "@/kv/types";

export type PasskeyDeviceType = "singleDevice" | "multiDevice";

export interface StoredPasskey {
  id: string;
  userId: string;
  webauthnUserId: string;
  publicKey: string;
  counter: number;
  transports?: string[] | null;
  deviceType?: PasskeyDeviceType | null;
  backedUp?: boolean | null;
  name?: string | null;
  createdAt: Date;
  lastUsedAt?: Date | null;
}

export type PasskeyUpdate = Partial<
  Pick<StoredPasskey, "counter" | "lastUsedAt" | "backedUp" | "name">
>;

export interface PasskeyStore {
  create(passkey: StoredPasskey): Promise<void>;
  findById(id: string): Promise<StoredPasskey | null>;
  listByUser(userId: string): Promise<StoredPasskey[]>;
  update(id: string, patch: PasskeyUpdate): Promise<void>;
  delete(id: string): Promise<void>;
}

const clone = (p: StoredPasskey): StoredPasskey => ({
  ...p,
  transports: p.transports ? [...p.transports] : p.transports,
});

export class InMemoryPasskeyStore implements PasskeyStore {
  private passkeys = new Map<string, StoredPasskey>();

  async create(passkey: StoredPasskey): Promise<void> {
    if (this.passkeys.has(passkey.id)) {
      throw new Error(`Passkey ${passkey.id} already exists`);
    }
    this.passkeys.set(passkey.id, clone(passkey));
  }

  async findById(id: string): Promise<StoredPasskey | null> {
    const found = this.passkeys.get(id);
    return found ? clone(found) : null;
  }

  async listByUser(userId: string): Promise<StoredPasskey[]> {
    return [...this.passkeys.values()].filter((p) => p.userId === userId).map(clone);
  }

  async update(id: string, patch: PasskeyUpdate): Promise<void> {
    const found = this.passkeys.get(id);
    if (found) this.passkeys.set(id, { ...found, ...patch });
  }

  async delete(id: string): Promise<void> {
    this.passkeys.delete(id);
  }
}

interface SerializedPasskey extends Omit<StoredPasskey, "createdAt" | "lastUsedAt"> {
  createdAt: string;
  lastUsedAt: string | null;
}

const serialize = (p: StoredPasskey): string =>
  JSON.stringify({
    ...p,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
  } satisfies SerializedPasskey);

const deserialize = (raw: string): StoredPasskey => {
  const s = JSON.parse(raw) as SerializedPasskey;
  return {
    ...s,
    createdAt: new Date(s.createdAt),
    lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt) : null,
  };
};

export class KVPasskeyStore implements PasskeyStore {
  constructor(
    private kv: KVAdapter,
    private prefix = "covara:passkey"
  ) {}

  private recordKey(id: string): string {
    return `${this.prefix}:cred:${id}`;
  }

  private userKey(userId: string): string {
    return `${this.prefix}:user:${userId}`;
  }

  async create(passkey: StoredPasskey): Promise<void> {
    if (await this.kv.exists(this.recordKey(passkey.id))) {
      throw new Error(`Passkey ${passkey.id} already exists`);
    }
    await this.kv.set(this.recordKey(passkey.id), serialize(passkey));
    await this.kv.sadd(this.userKey(passkey.userId), passkey.id);
  }

  async findById(id: string): Promise<StoredPasskey | null> {
    const raw = await this.kv.get(this.recordKey(id));
    return raw ? deserialize(raw) : null;
  }

  async listByUser(userId: string): Promise<StoredPasskey[]> {
    const ids = await this.kv.smembers(this.userKey(userId));
    const out: StoredPasskey[] = [];
    for (const id of ids) {
      const found = await this.findById(id);
      if (found) out.push(found);
    }
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async update(id: string, patch: PasskeyUpdate): Promise<void> {
    const found = await this.findById(id);
    if (found) await this.kv.set(this.recordKey(id), serialize({ ...found, ...patch }));
  }

  async delete(id: string): Promise<void> {
    const found = await this.findById(id);
    await this.kv.del(this.recordKey(id));
    if (found) await this.kv.srem(this.userKey(found.userId), id);
  }
}

export const createKVPasskeyStore = (kv: KVAdapter, prefix?: string): KVPasskeyStore =>
  new KVPasskeyStore(kv, prefix);

export type PasskeyChallengePurpose = "registration" | "authentication";

export interface PasskeyChallenge {
  purpose: PasskeyChallengePurpose;
  expiresAt: number;
  userId?: string;
  webauthnUserId?: string;
}

export interface PasskeyChallengeStore {
  set(challenge: string, data: PasskeyChallenge, ttlMs: number): Promise<void> | void;
  consume(challenge: string): Promise<PasskeyChallenge | null> | PasskeyChallenge | null;
}

const live = (data: PasskeyChallenge | null): PasskeyChallenge | null =>
  data && data.expiresAt > Date.now() ? data : null;

export class InMemoryPasskeyChallengeStore implements PasskeyChallengeStore {
  private entries = new Map<string, PasskeyChallenge>();

  set(challenge: string, data: PasskeyChallenge): void {
    if (this.entries.size >= 1000) {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(key);
      }
    }
    this.entries.set(challenge, data);
  }

  consume(challenge: string): PasskeyChallenge | null {
    const data = this.entries.get(challenge) ?? null;
    this.entries.delete(challenge);
    return live(data);
  }
}

export const createKVPasskeyChallengeStore = (
  kv: KVAdapter,
  prefix = "covara:passkey:challenge:"
): PasskeyChallengeStore => ({
  async set(challenge, data, ttlMs) {
    await kv.set(`${prefix}${challenge}`, JSON.stringify(data), { px: ttlMs });
  },
  async consume(challenge) {
    const key = `${prefix}${challenge}`;
    const raw = await kv.get(key);
    if (!raw) return null;
    // del() reports how many keys it removed, so only one of several concurrent
    // consumers of the same challenge observes 1 and wins.
    const removed = await kv.del(key);
    if (removed !== 1) return null;
    return live(JSON.parse(raw) as PasskeyChallenge);
  },
});
