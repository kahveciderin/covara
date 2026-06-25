/**
 * Token-bucket budget store. Each identity class has a `capacity` and a
 * `refillPerMinute`; operations deduct their declared cost. Exhaustion is a
 * hard rejection (the caller raises 429). Backed by the global KV (or an
 * injected store) with an in-process memory fallback, mirroring the rate-limit
 * store's KV-or-memory pattern.
 */

import type { KVAdapter } from "@/kv";
import { getGlobalKV, hasGlobalKV } from "@/kv";
import type { BudgetClassConfig } from "./config";

const BUDGET_PREFIX = "covara:budget:";

export interface BudgetConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const memoryBuckets = new Map<string, BucketState>();

const refill = (
  state: BucketState,
  cfg: BudgetClassConfig,
  now: number
): BucketState => {
  const elapsedMs = Math.max(0, now - state.lastRefillMs);
  const refilled = (elapsedMs / 60_000) * cfg.refillPerMinute;
  return {
    tokens: Math.min(cfg.capacity, state.tokens + refilled),
    lastRefillMs: now,
  };
};

const retryAfterMsFor = (deficit: number, cfg: BudgetClassConfig): number => {
  if (cfg.refillPerMinute <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.ceil((deficit / cfg.refillPerMinute) * 60_000);
};

export class BudgetStore {
  constructor(private readonly injected?: KVAdapter) {}

  private get kv(): KVAdapter | null {
    return this.injected ?? (hasGlobalKV() ? getGlobalKV() : null);
  }

  private async load(
    key: string,
    cfg: BudgetClassConfig,
    now: number
  ): Promise<BucketState> {
    const kv = this.kv;
    if (!kv) {
      const existing = memoryBuckets.get(key);
      return existing
        ? refill(existing, cfg, now)
        : { tokens: cfg.capacity, lastRefillMs: now };
    }
    const data = await kv.hgetall(`${BUDGET_PREFIX}${key}`);
    if (!data || data.tokens === undefined || data.lastRefillMs === undefined) {
      return { tokens: cfg.capacity, lastRefillMs: now };
    }
    return refill(
      { tokens: parseFloat(data.tokens), lastRefillMs: parseInt(data.lastRefillMs, 10) },
      cfg,
      now
    );
  }

  private async save(
    key: string,
    state: BucketState,
    cfg: BudgetClassConfig
  ): Promise<void> {
    const kv = this.kv;
    if (!kv) {
      memoryBuckets.set(key, state);
      return;
    }
    const kvKey = `${BUDGET_PREFIX}${key}`;
    await kv.hmset(kvKey, {
      tokens: String(state.tokens),
      lastRefillMs: String(state.lastRefillMs),
    });
    const secondsToFull =
      cfg.refillPerMinute > 0
        ? Math.ceil(((cfg.capacity - state.tokens) / cfg.refillPerMinute) * 60) + 1
        : 0;
    if (secondsToFull > 0) {
      await kv.expire(kvKey, secondsToFull);
    }
  }

  /**
   * Inspect the bucket without deducting: report current (refilled) tokens,
   * whether `cost` fits, the deficit, and the wait for a hard limit. Used to
   * decide whether a request is within budget before any charge.
   */
  async assess(
    key: string,
    cost: number,
    cfg: BudgetClassConfig,
    now = Date.now()
  ): Promise<BudgetConsumeResult & { tokens: number; sufficient: boolean; deficit: number }> {
    const state = await this.load(key, cfg, now);
    const sufficient = state.tokens >= cost;
    const deficit = Math.max(0, cost - state.tokens);
    return {
      allowed: sufficient,
      sufficient,
      tokens: state.tokens,
      remaining: state.tokens,
      deficit,
      retryAfterMs: sufficient ? 0 : retryAfterMsFor(deficit, cfg),
    };
  }

  /**
   * Debit `cost` from the bucket, flooring at zero (never negative). Used both
   * for an in-budget charge and to settle the overdraft after a solved PoW
   * challenge.
   */
  async deduct(
    key: string,
    cost: number,
    cfg: BudgetClassConfig,
    now = Date.now()
  ): Promise<number> {
    if (cost <= 0) return (await this.load(key, cfg, now)).tokens;
    const state = await this.load(key, cfg, now);
    state.tokens = Math.max(0, state.tokens - cost);
    await this.save(key, state, cfg);
    return state.tokens;
  }

  async consume(
    key: string,
    cost: number,
    cfg: BudgetClassConfig,
    now = Date.now()
  ): Promise<BudgetConsumeResult> {
    const state = await this.load(key, cfg, now);
    if (cost <= 0) {
      return { allowed: true, remaining: state.tokens, retryAfterMs: 0 };
    }
    if (state.tokens >= cost) {
      state.tokens -= cost;
      await this.save(key, state, cfg);
      return { allowed: true, remaining: state.tokens, retryAfterMs: 0 };
    }
    await this.save(key, state, cfg);
    return {
      allowed: false,
      remaining: state.tokens,
      retryAfterMs: retryAfterMsFor(cost - state.tokens, cfg),
    };
  }

  async credit(
    key: string,
    amount: number,
    cfg: BudgetClassConfig,
    now = Date.now()
  ): Promise<void> {
    if (amount <= 0) return;
    const state = await this.load(key, cfg, now);
    state.tokens = Math.min(cfg.capacity, state.tokens + amount);
    await this.save(key, state, cfg);
  }
}

export const clearBudgetMemoryForTests = (): void => {
  memoryBuckets.clear();
};
