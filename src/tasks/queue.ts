import { KVAdapter } from "@/kv/types";
import { Task } from "./types";
import { createTaskLock } from "./lock";
import { createTaskStorage } from "./storage";

const PRIORITY_BUCKETS = [0, 25, 50, 75, 100];

const getQueueKey = (priority: number): string => {
  const bucket = PRIORITY_BUCKETS.find((b) => priority <= b) ?? 100;
  return `covara:tasks:queue:${bucket}`;
};

export interface TaskQueue {
  add(taskId: string, priority: number, scheduledFor: number): Promise<void>;
  claimNext(workerId: string, taskTypes?: string[]): Promise<Task | null>;
  remove(taskId: string, priority: number): Promise<void>;
  getQueueDepth(priority?: number): Promise<number>;
  getScheduledTasks(limit?: number): Promise<string[]>;
}

export const createTaskQueue = (kv: KVAdapter): TaskQueue => {
  const lock = createTaskLock(kv);
  const storage = createTaskStorage(kv);

  return {
    async add(
      taskId: string,
      priority: number,
      scheduledFor: number
    ): Promise<void> {
      const queueKey = getQueueKey(priority);
      await kv.zadd(queueKey, scheduledFor, taskId);
    },

    async claimNext(
      workerId: string,
      taskTypes?: string[]
    ): Promise<Task | null> {
      const now = Date.now();

      for (const bucket of PRIORITY_BUCKETS) {
        const queueKey = `covara:tasks:queue:${bucket}`;

        const taskIds = await kv.zrangebyscore(queueKey, "-inf", now, {
          limit: { offset: 0, count: 10 },
        });

        for (const taskId of taskIds) {
          const acquired = await lock.acquire(taskId, workerId);
          if (!acquired) continue;

          const task = await storage.get(taskId);
          if (!task) {
            await lock.release(taskId, workerId);
            await kv.zrem(queueKey, taskId);
            continue;
          }

          if (task.status !== "pending" && task.status !== "scheduled") {
            await lock.release(taskId, workerId);
            await kv.zrem(queueKey, taskId);
            continue;
          }

          if (taskTypes && !taskTypes.includes(task.name)) {
            await lock.release(taskId, workerId);
            continue;
          }

          await kv.zrem(queueKey, taskId);
          return task;
        }
      }

      return null;
    },

    async remove(taskId: string, priority: number): Promise<void> {
      const queueKey = getQueueKey(priority);
      await kv.zrem(queueKey, taskId);
    },

    async getQueueDepth(priority?: number): Promise<number> {
      if (priority !== undefined) {
        return kv.zcard(getQueueKey(priority));
      }
      let total = 0;
      for (const bucket of PRIORITY_BUCKETS) {
        total += await kv.zcard(`covara:tasks:queue:${bucket}`);
      }
      return total;
    },

    async getScheduledTasks(limit: number = 100): Promise<string[]> {
      const allTasks: string[] = [];
      for (const bucket of PRIORITY_BUCKETS) {
        const queueKey = `covara:tasks:queue:${bucket}`;
        const tasks = await kv.zrange(queueKey, 0, limit - allTasks.length - 1);
        allTasks.push(...tasks);
        if (allTasks.length >= limit) break;
      }
      return allTasks;
    },
  };
};
