import { KVAdapter } from "@/kv/types";

const LOCK_PREFIX = "covara:tasks:lock:";
const DEFAULT_LOCK_TTL = 30;

export interface TaskLock {
  acquire(
    taskId: string,
    workerId: string,
    ttlSeconds?: number
  ): Promise<boolean>;
  extend(
    taskId: string,
    workerId: string,
    ttlSeconds?: number
  ): Promise<boolean>;
  release(taskId: string, workerId: string): Promise<boolean>;
  isHeld(taskId: string, workerId: string): Promise<boolean>;
}

export const createTaskLock = (kv: KVAdapter): TaskLock => ({
  async acquire(
    taskId: string,
    workerId: string,
    ttlSeconds: number = DEFAULT_LOCK_TTL
  ): Promise<boolean> {
    const key = `${LOCK_PREFIX}${taskId}`;
    await kv.set(key, workerId, { nx: true, ex: ttlSeconds });
    const holder = await kv.get(key);
    return holder === workerId;
  },

  async extend(
    taskId: string,
    workerId: string,
    ttlSeconds: number = DEFAULT_LOCK_TTL
  ): Promise<boolean> {
    const key = `${LOCK_PREFIX}${taskId}`;
    const holder = await kv.get(key);
    if (holder !== workerId) return false;
    return kv.expire(key, ttlSeconds);
  },

  async release(taskId: string, workerId: string): Promise<boolean> {
    const key = `${LOCK_PREFIX}${taskId}`;
    const holder = await kv.get(key);
    if (holder !== workerId) return false;
    await kv.del(key);
    return true;
  },

  async isHeld(taskId: string, workerId: string): Promise<boolean> {
    const key = `${LOCK_PREFIX}${taskId}`;
    const holder = await kv.get(key);
    return holder === workerId;
  },
});
