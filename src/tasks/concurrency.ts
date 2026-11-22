import { KVAdapter } from "@/kv/types";

// Not the pre-0.17.3 counter key: one left stuck by a crash must not carry over.
const SLOT_PREFIX = "covara:tasks:slots:";

export const DEFAULT_LEASE_MS = 30000;

export interface ConcurrencyLimiter {
  tryReserve(taskName: string, maxConcurrency: number): Promise<boolean>;
  release(taskName: string): Promise<void>;
  getRunning(taskName: string): Promise<number>;
}

export type ReleaseSlot = () => Promise<void>;

// Each slot is its own expiring key, renewed by its holder, so a holder that
// dies frees it. SET NX decides a race on every adapter without needing Lua.
// The sorted set only serves `getRunning`.
export const createSlotLeases = (kv: KVAdapter, leaseMs: number = DEFAULT_LEASE_MS) => {
  const ttlSeconds = Math.max(1, Math.ceil(leaseMs / 1000));
  const ttlMs = ttlSeconds * 1000;

  return {
    async acquire(taskName: string, maxConcurrency: number): Promise<ReleaseSlot | null> {
      const index = `${SLOT_PREFIX}${taskName}`;
      const slots = Array.from({ length: maxConcurrency }, (_, i) => `${index}:${i}`);
      const holders = await Promise.all(slots.map((slot) => kv.get(slot)));
      const token = crypto.randomUUID();

      for (const [i, key] of slots.entries()) {
        if (holders[i] !== null) continue;
        await kv.set(key, token, { nx: true, ex: ttlSeconds });
        if ((await kv.get(key)) !== token) continue;

        let released = false;
        let renewing: Promise<void> | undefined;
        const renew = async (): Promise<void> => {
          const holder = await kv.get(key);
          if (holder === token) await kv.expire(key, ttlSeconds);
          else if (holder === null) await kv.set(key, token, { nx: true, ex: ttlSeconds });
          else return;
          await kv.zadd(index, Date.now() + ttlMs, token);
        };
        const timer = setInterval(() => {
          if (renewing || released) return;
          renewing = renew()
            .catch(() => {
              // transient KV error: the next tick retries
            })
            .finally(() => (renewing = undefined));
        }, ttlMs / 3);
        (timer as { unref?: () => void }).unref?.();

        const release: ReleaseSlot = async () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          await renewing;
          if ((await kv.get(key)) === token) await kv.del(key);
          await kv.zrem(index, token);
        };

        await kv.zadd(index, Date.now() + ttlMs, token);
        const expired = await kv.zrangebyscore(index, "-inf", Date.now() - ttlMs);
        if (expired.length > 0) await kv.zrem(index, ...expired);
        return release;
      }

      return null;
    },

    async getRunning(taskName: string): Promise<number> {
      return (await kv.zrangebyscore(`${SLOT_PREFIX}${taskName}`, Date.now(), "+inf")).length;
    },
  };
};

// A reservation is renewed by the limiter that made it, until `release`.
export const createConcurrencyLimiter = (
  kv: KVAdapter,
  options: { leaseMs?: number } = {}
): ConcurrencyLimiter => {
  const leases = createSlotLeases(kv, options.leaseMs);
  const held = new Map<string, ReleaseSlot[]>();

  return {
    async tryReserve(taskName: string, maxConcurrency: number): Promise<boolean> {
      if (maxConcurrency <= 0) return true;
      const release = await leases.acquire(taskName, maxConcurrency);
      if (!release) return false;
      held.set(taskName, [...(held.get(taskName) ?? []), release]);
      return true;
    },

    async release(taskName: string): Promise<void> {
      await held.get(taskName)?.pop()?.();
    },

    getRunning: leases.getRunning,
  };
};
