import { getGlobalKV, hasGlobalKV, KVAdapter } from "@/kv";

export interface CreditEntry {
  delta: number;
  balance: number;
  reason?: string;
  at: number;
  metadata?: Record<string, unknown>;
}

export interface CreditsLedger {
  grant(account: string, amount: number, opts?: { reason?: string; metadata?: Record<string, unknown> }): Promise<number>;
  consume(
    account: string,
    amount: number,
    opts?: { reason?: string; metadata?: Record<string, unknown>; allowNegative?: boolean }
  ): Promise<{ ok: boolean; balance: number }>;
  balance(account: string): Promise<number>;
  set(account: string, amount: number, opts?: { reason?: string }): Promise<number>;
  history(account: string, limit?: number): Promise<CreditEntry[]>;
}

const BALANCE_PREFIX = "covara:credits:balance:";
const HISTORY_PREFIX = "covara:credits:history:";
const HISTORY_MAX = 1000;

// KV-backed credits ledger. Balance mutations use the KV's atomic incrBy so
// concurrent grant/consume across instances stay consistent; every change
// appends to a capped per-account history list.
export const createCreditsLedger = (kv?: KVAdapter): CreditsLedger => {
  const resolveKv = (): KVAdapter => {
    if (kv) return kv;
    if (!hasGlobalKV()) {
      throw new Error("Credits ledger requires a KV store. Configure a global KV or pass one in.");
    }
    return getGlobalKV();
  };

  const record = async (
    store: KVAdapter,
    account: string,
    delta: number,
    balance: number,
    opts?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> => {
    const entry: CreditEntry = {
      delta,
      balance,
      reason: opts?.reason,
      at: Date.now(),
      metadata: opts?.metadata,
    };
    await store.lpush(`${HISTORY_PREFIX}${account}`, JSON.stringify(entry));
  };

  return {
    async grant(account, amount, opts) {
      if (amount < 0) throw new Error("grant amount must be >= 0");
      const store = resolveKv();
      const balance = await store.incrBy(`${BALANCE_PREFIX}${account}`, amount);
      await record(store, account, amount, balance, opts);
      return balance;
    },

    async consume(account, amount, opts) {
      if (amount < 0) throw new Error("consume amount must be >= 0");
      const store = resolveKv();
      const key = `${BALANCE_PREFIX}${account}`;
      const current = Number((await store.get(key)) ?? 0);
      if (!opts?.allowNegative && current < amount) {
        return { ok: false, balance: current };
      }
      const balance = await store.incrBy(key, -amount);
      await record(store, account, -amount, balance, opts);
      return { ok: true, balance };
    },

    async balance(account) {
      const store = resolveKv();
      return Number((await store.get(`${BALANCE_PREFIX}${account}`)) ?? 0);
    },

    async set(account, amount, opts) {
      const store = resolveKv();
      await store.set(`${BALANCE_PREFIX}${account}`, String(amount));
      await record(store, account, amount, amount, opts);
      return amount;
    },

    async history(account, limit = 50) {
      const store = resolveKv();
      const raw = await store.lrange(`${HISTORY_PREFIX}${account}`, 0, Math.min(limit, HISTORY_MAX) - 1);
      return raw.map((r) => JSON.parse(r) as CreditEntry);
    },
  };
};
