import { KVAdapter } from "@/kv/types";

const RUNNING_COUNT_PREFIX = "covara:tasks:concurrency:";

export interface ConcurrencyLimiter {
  tryReserve(taskName: string, maxConcurrency: number): Promise<boolean>;
  release(taskName: string): Promise<void>;
  getRunning(taskName: string): Promise<number>;
}

export const createConcurrencyLimiter = (
  kv: KVAdapter
): ConcurrencyLimiter => ({
  async tryReserve(
    taskName: string,
    maxConcurrency: number
  ): Promise<boolean> {
    if (maxConcurrency <= 0) return true;
    const key = `${RUNNING_COUNT_PREFIX}${taskName}`;
    const count = await kv.incr(key);
    if (count > maxConcurrency) {
      await kv.decr(key);
      return false;
    }
    return true;
  },

  async release(taskName: string): Promise<void> {
    const key = `${RUNNING_COUNT_PREFIX}${taskName}`;
    const count = await kv.decr(key);
    if (count < 0) {
      await kv.set(key, "0");
    }
  },

  async getRunning(taskName: string): Promise<number> {
    const key = `${RUNNING_COUNT_PREFIX}${taskName}`;
    const raw = await kv.get(key);
    return raw ? parseInt(raw, 10) : 0;
  },
});
