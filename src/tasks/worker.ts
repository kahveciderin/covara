import { KVAdapter } from "@/kv/types";
import {
  Task,
  TaskContext,
  TaskDefinition,
  WorkerConfig,
  WorkerStats,
  StopOptions,
} from "./types";
import { createTaskLock } from "./lock";
import { createTaskQueue, INFLIGHT_KEY } from "./queue";
import { createTaskStorage } from "./storage";
import { createDeadLetterQueue } from "./dlq";
import { resolveRetryDelay, shouldRetry } from "./retry";
import { createSlotLeases, ReleaseSlot } from "./concurrency";
import {
  createIdempotencyStore,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
} from "./idempotency";
import { TaskRegistry } from "./scheduler";
import { getLogger } from "@/server/logger";
import { DrizzleDatabase } from "@/resource/types";
import {
  trackMutations,
  isTrackedDb,
  TableRegistration,
} from "@/resource/track-mutations";

const WORKERS_KEY = "covara:tasks:workers";
const NOTIFY_CHANNEL = "covara:tasks:notify";
const RUNNING_INDEX_KEY = "covara:tasks:status:running";
const RECLAIM_INTERVAL_MS = 5000;

export const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const MAX_POLL_BACKOFF_MS = 5000;

export interface TaskWorker {
  start(): Promise<void>;
  stop(options?: StopOptions): Promise<void>;
  drain(timeoutMs?: number): Promise<void>;
  pause(): void;
  resume(): void;
  getStats(): WorkerStats;
}

export interface TaskWorkerDbConfig {
  db: DrizzleDatabase;
  tables: Record<string, TableRegistration>;
}

export const createTaskWorker = (
  kv: KVAdapter,
  registry: TaskRegistry,
  config: WorkerConfig = {},
  dbConfig?: TaskWorkerDbConfig
): TaskWorker => {
  const workerId = config.id ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  const concurrency = config.concurrency ?? 5;
  const pollInterval = config.pollIntervalMs ?? 1000;
  const lockTtl = Math.max(1, Math.ceil((config.lockTtlMs ?? 30000) / 1000));
  // A lock that lapses under a live task would get it reclaimed and run twice.
  const heartbeatInterval = Math.min(config.heartbeatMs ?? 10000, (lockTtl * 1000) / 3);

  const trackedDb = dbConfig
    ? isTrackedDb(dbConfig.db)
      ? dbConfig.db
      : trackMutations(dbConfig.db, dbConfig.tables)
    : undefined;

  const lock = createTaskLock(kv);
  const queue = createTaskQueue(kv);
  const storage = createTaskStorage(kv);
  const slots = createSlotLeases(kv, lockTtl * 1000);
  const idempotencyStore = createIdempotencyStore(kv);

  let running = false;
  let draining = false;
  let paused = false;
  let processedCount = 0;
  let failedCount = 0;
  const startTime = Date.now();
  const activeTasks = new Map<string, AbortController>();
  const forceStopped = new Set<string>();
  const heldSlots = new Map<string, ReleaseSlot>();
  // A task's own timers: stop() must clear them even if its handler never settles,
  // or they keep the process alive.
  const taskTimers = new Map<string, () => void>();
  let reclaimTimer: ReturnType<typeof setInterval> | undefined;
  let reclaiming = false;

  const requeue = async (task: Task): Promise<string> => {
    await storage.store(task);
    await queue.add(task.id, task.priority, task.scheduledFor);
    return task.id;
  };

  const dlq = createDeadLetterQueue(kv, requeue, {
    onDlqEnqueue: config.onDlqEnqueue,
  });

  const handleTaskError = async (
    task: Task,
    error: Error,
    definition: TaskDefinition
  ): Promise<void> => {
    const nextAttempt = task.attempt + 1;
    const retryConfig = definition.retry ?? {};

    if (shouldRetry(error, nextAttempt, task.maxAttempts, retryConfig)) {
      const backoff = resolveRetryDelay(error, nextAttempt, retryConfig);
      const scheduledFor = Date.now() + backoff;

      await storage.updateStatus(task.id, task.status, "scheduled", {
        attempt: nextAttempt,
        scheduledFor,
        lastError: error.message,
        workerId: undefined,
      });

      await queue.add(task.id, task.priority, scheduledFor);
    } else {
      await dlq.add(task, error.message);
      failedCount++;
    }
  };

  const processTask = async (
    task: Task,
    definition: TaskDefinition,
    releaseSlot: ReleaseSlot | undefined
  ): Promise<void> => {
    const controller = new AbortController();
    activeTasks.set(task.id, controller);
    if (releaseSlot) heldSlots.set(task.id, releaseSlot);
    let current = task;

    const idempotencyKey = task.idempotencyKey;
    const retentionMs =
      definition.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    const resultTtlMs = definition.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    const resultExpiresAt = Date.now() + resultTtlMs;

    const heartbeat = setInterval(async () => {
      try {
        await storage.setHeartbeat(task.id, Date.now());
        const extended = await lock.extend(task.id, workerId, lockTtl);
        if (!extended) {
          controller.abort();
        }
      } catch (error) {
        console.error(`Task ${task.id} heartbeat failed:`, error);
      }
    }, heartbeatInterval);

    try {
      if (idempotencyKey) {
        const completed = await idempotencyStore.getCompleted(idempotencyKey);
        if (completed) {
          await storage.updateStatus(task.id, task.status, "completed", {
            result: completed.result,
            completedAt: Date.now(),
            resultExpiresAt: Date.now() + resultTtlMs,
          });
          processedCount++;
          return;
        }
      }

      if (forceStopped.has(task.id)) return;

      const startedAt = Date.now();
      await storage.updateStatus(task.id, task.status, "running", {
        workerId,
        startedAt,
        lastHeartbeatAt: startedAt,
      });
      current = { ...task, status: "running" };

      const ctx: TaskContext = {
        taskId: task.id,
        attempt: task.attempt + 1,
        scheduledAt: new Date(task.scheduledFor),
        startedAt: new Date(startedAt),
        workerId,
        signal: controller.signal,
        db: trackedDb,
        reportProgress: async (percent: number, message?: string) => {
          const clamped = Math.max(0, Math.min(100, percent));
          await storage.setProgress(task.id, {
            percent: clamped,
            ...(message !== undefined && { message }),
            updatedAt: Date.now(),
          });
        },
      };

      const timeoutMs = definition.timeout ?? 30000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Task timeout")), timeoutMs);
      });
      taskTimers.set(task.id, () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
      });

      const result = await Promise.race([
        definition.handler(ctx, task.input),
        timeoutPromise,
      ]);

      if (forceStopped.has(task.id)) return;

      if (idempotencyKey) {
        await idempotencyStore.markCompleted(
          idempotencyKey,
          { taskId: task.id, result, completedAt: Date.now() },
          retentionMs
        );
      }

      await storage.updateStatus(task.id, "running", "completed", {
        result,
        completedAt: Date.now(),
        resultExpiresAt,
      });

      processedCount++;
    } catch (error) {
      if (forceStopped.has(task.id)) return;

      if (controller.signal.aborted) {
        // Someone else holding the lock means the task is theirs now.
        if (!(await lock.acquire(task.id, workerId, lockTtl))) return;
        await storage.updateStatus(task.id, "running", "scheduled", {
          lastError: "Worker lost lock",
          workerId: undefined,
        });
        await queue.add(task.id, task.priority, Date.now());
      } else {
        await handleTaskError(current, error as Error, definition);
      }
    } finally {
      clearInterval(heartbeat);
      taskTimers.get(task.id)?.();
      taskTimers.delete(task.id);
      // stop() does its own cleanup, and must requeue before the claim is dropped.
      const stopped = forceStopped.delete(task.id);
      activeTasks.delete(task.id);
      heldSlots.delete(task.id);
      await releaseSlot?.();
      if (!stopped) {
        if (await lock.isHeld(task.id, workerId)) await kv.zrem(INFLIGHT_KEY, task.id);
        await lock.release(task.id, workerId);
      }
    }
  };

  const unclaim = async (task: Task): Promise<void> => {
    await queue.add(task.id, task.priority, Date.now());
    await kv.zrem(INFLIGHT_KEY, task.id);
    await lock.release(task.id, workerId);
  };

  const pollOnce = async (): Promise<void> => {
    if (activeTasks.size >= concurrency) {
      await sleep(100);
      return;
    }

    const task = await queue.claimNext(workerId, config.taskTypes, lockTtl);
    if (!task) {
      await sleep(pollInterval);
      return;
    }

    const definition = registry.get(task.name);
    if (!definition) {
      await dlq.add(task, `Unknown task type: ${task.name}`);
      failedCount++;
      await kv.zrem(INFLIGHT_KEY, task.id);
      await lock.release(task.id, workerId);
      return;
    }

    let releaseSlot: ReleaseSlot | undefined;
    if (definition.maxConcurrency && definition.maxConcurrency > 0) {
      releaseSlot = (await slots.acquire(task.name, definition.maxConcurrency)) ?? undefined;
      if (!releaseSlot) {
        await unclaim(task);
        await sleep(pollInterval);
        return;
      }
    }

    // stop() or drain() may have been called while the claim was in flight.
    if (!running || draining) {
      await releaseSlot?.();
      await unclaim(task);
      return;
    }

    processTask(task, definition, releaseSlot).catch((err) =>
      console.error(`Task ${task.id} error:`, err)
    );
  };

  let wakeBackoff: (() => void) | null = null;
  const backoff = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeBackoff = null;
        resolve();
      }, ms);
      wakeBackoff = () => {
        clearTimeout(timer);
        wakeBackoff = null;
        resolve();
      };
    });

  const poll = async (): Promise<void> => {
    let failures = 0;
    while (running && !draining) {
      if (paused) {
        await sleep(Math.min(100, pollInterval));
        continue;
      }
      try {
        await pollOnce();
        if (failures > 0) {
          getLogger().info("Task worker polling again", { workerId, failedPolls: failures });
          failures = 0;
        }
      } catch (error) {
        if (failures++ === 0) {
          getLogger().warn("Task worker poll failed, backing off until it succeeds", {
            workerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const cap = Math.max(pollInterval, MAX_POLL_BACKOFF_MS);
        await backoff(Math.min(pollInterval * 2 ** Math.min(failures - 1, 20), cap));
      }
    }
  };

  // An in-flight task whose lock has expired lost its worker. Holding that lock
  // while requeueing is what keeps two reclaimers, or a reclaimer and a live
  // worker, from both acting on it.
  const reclaimTask = async (taskId: string): Promise<void> => {
    const reclaimer = `${workerId}:reclaim`;
    if (!(await lock.acquire(taskId, reclaimer, lockTtl))) return;
    try {
      const task = await storage.get(taskId);

      if (task?.status === "running") {
        // No workerId: owned by the Cloudflare Queues consumer, which retries it.
        if (!task.workerId) return;
        const attempt = task.attempt + 1;
        const reason = "Worker lost during execution";
        if (attempt >= task.maxAttempts) {
          await dlq.add({ ...task, attempt }, reason);
          failedCount++;
        } else {
          const scheduledFor = Date.now();
          await storage.updateStatus(taskId, "running", "scheduled", {
            attempt,
            scheduledFor,
            lastError: reason,
            workerId: undefined,
          });
          await queue.add(taskId, task.priority, scheduledFor);
        }
      } else {
        if (task?.status === "pending" || task?.status === "scheduled") {
          await queue.add(taskId, task.priority, task.scheduledFor);
        }
        await kv.srem(RUNNING_INDEX_KEY, taskId);
      }

      await kv.zrem(INFLIGHT_KEY, taskId);
    } finally {
      await lock.release(taskId, reclaimer);
    }
  };

  const reclaimLostTasks = async (): Promise<void> => {
    if (reclaiming) return;
    reclaiming = true;
    try {
      const candidates = new Set([
        ...(await kv.zrange(INFLIGHT_KEY, 0, -1)),
        ...(await kv.smembers(RUNNING_INDEX_KEY)),
      ]);
      for (const taskId of candidates) {
        if (!running) break;
        if (activeTasks.has(taskId)) continue;
        try {
          await reclaimTask(taskId);
        } catch (error) {
          console.error(`Task ${taskId} reclaim failed:`, error);
        }
      }
    } catch (error) {
      console.error(`Task worker ${workerId} reclaim failed:`, error);
    } finally {
      reclaiming = false;
    }
  };

  return {
    async start(): Promise<void> {
      running = true;

      await kv.sadd(WORKERS_KEY, workerId);

      try {
        await kv.subscribe(NOTIFY_CHANNEL, () => {
          // Wake up if needed - the poll loop handles this
        });
      } catch {
        // Pub/sub might not be available in memory mode
      }

      poll();

      void reclaimLostTasks();
      clearInterval(reclaimTimer);
      reclaimTimer = setInterval(
        () => void reclaimLostTasks(),
        Math.min(RECLAIM_INTERVAL_MS, lockTtl * 1000)
      );
      (reclaimTimer as { unref?: () => void }).unref?.();
    },

    async drain(timeoutMs: number = 30000): Promise<void> {
      draining = true;

      const deadline = Date.now() + timeoutMs;
      while (activeTasks.size > 0 && Date.now() < deadline) {
        await sleep(50);
      }

      await this.stop({ drain: false });
    },

    async stop(options: StopOptions = {}): Promise<void> {
      if (options.drain) {
        await this.drain(options.timeoutMs);
        return;
      }

      running = false;
      draining = false;
      clearInterval(reclaimTimer);
      wakeBackoff?.();

      // A snapshot: aborting lets each task's own cleanup shrink both maps.
      for (const [taskId, controller] of [...activeTasks]) {
        if (!activeTasks.has(taskId)) continue;
        const releaseSlot = heldSlots.get(taskId);
        forceStopped.add(taskId);
        controller.abort();
        taskTimers.get(taskId)?.();
        taskTimers.delete(taskId);
        const task = await storage.get(taskId);
        // Not if it finished meanwhile, or another worker has taken it over.
        if (task && (await lock.isHeld(taskId, workerId))) {
          if (task.status === "running") {
            await storage.updateStatus(taskId, "running", "scheduled", {
              workerId: undefined,
            });
          }
          if (["running", "pending", "scheduled"].includes(task.status)) {
            await queue.add(taskId, task.priority, Date.now());
          }
          await kv.zrem(INFLIGHT_KEY, taskId);
        }
        await releaseSlot?.();
        await lock.release(taskId, workerId);
      }
      activeTasks.clear();
      heldSlots.clear();

      try {
        await kv.unsubscribe(NOTIFY_CHANNEL);
      } catch {
        // Ignore
      }

      await kv.srem(WORKERS_KEY, workerId);
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    getStats(): WorkerStats {
      return {
        id: workerId,
        status: running ? (paused ? "paused" : "running") : "stopped",
        activeTasks: activeTasks.size,
        processedCount,
        failedCount,
        uptime: Date.now() - startTime,
      };
    },
  };
};

export const startTaskWorkers = async (
  kv: KVAdapter,
  registry: TaskRegistry,
  count: number = 1,
  config: Omit<WorkerConfig, "id"> = {},
  dbConfig?: TaskWorkerDbConfig
): Promise<TaskWorker[]> => {
  const workers: TaskWorker[] = [];

  for (let i = 0; i < count; i++) {
    const worker = createTaskWorker(
      kv,
      registry,
      {
        ...config,
        id: `worker-${i}-${crypto.randomUUID().slice(0, 8)}`,
      },
      dbConfig
    );
    await worker.start();
    workers.push(worker);
  }

  return workers;
};
