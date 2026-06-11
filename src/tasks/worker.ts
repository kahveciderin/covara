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
import { createTaskQueue } from "./queue";
import { createTaskStorage } from "./storage";
import { createDeadLetterQueue } from "./dlq";
import { calculateBackoff, shouldRetry } from "./retry";
import { createConcurrencyLimiter } from "./concurrency";
import {
  createIdempotencyStore,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
} from "./idempotency";
import { TaskRegistry } from "./scheduler";
import { DrizzleDatabase } from "@/resource/types";
import {
  trackMutations,
  isTrackedDb,
  TableRegistration,
} from "@/resource/track-mutations";

const WORKERS_KEY = "covara:tasks:workers";
const NOTIFY_CHANNEL = "covara:tasks:notify";

export const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const lockTtl = Math.ceil((config.lockTtlMs ?? 30000) / 1000);
  const heartbeatInterval = config.heartbeatMs ?? 10000;

  const trackedDb = dbConfig
    ? isTrackedDb(dbConfig.db)
      ? dbConfig.db
      : trackMutations(dbConfig.db, dbConfig.tables)
    : undefined;

  const lock = createTaskLock(kv);
  const queue = createTaskQueue(kv);
  const storage = createTaskStorage(kv);
  const concurrencyLimiter = createConcurrencyLimiter(kv);
  const idempotencyStore = createIdempotencyStore(kv);

  let running = false;
  let draining = false;
  let paused = false;
  let processedCount = 0;
  let failedCount = 0;
  const startTime = Date.now();
  const activeTasks = new Map<string, AbortController>();
  const forceStopped = new Set<string>();

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
      const backoff = calculateBackoff(nextAttempt, retryConfig);
      const scheduledFor = Date.now() + backoff;

      await storage.updateStatus(task.id, "running", "scheduled", {
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
    reservedConcurrency: boolean
  ): Promise<void> => {
    const controller = new AbortController();
    activeTasks.set(task.id, controller);

    const idempotencyKey = task.idempotencyKey;
    const retentionMs =
      definition.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    const resultTtlMs = definition.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    const resultExpiresAt = Date.now() + resultTtlMs;

    const heartbeat = setInterval(async () => {
      await storage.setHeartbeat(task.id, Date.now());
      const extended = await lock.extend(task.id, workerId, lockTtl);
      if (!extended) {
        controller.abort();
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

      const startedAt = Date.now();
      await storage.updateStatus(task.id, task.status, "running", {
        workerId,
        startedAt,
        lastHeartbeatAt: startedAt,
      });

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
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Task timeout")), timeoutMs)
      );

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
        await storage.updateStatus(task.id, "running", "scheduled", {
          lastError: "Worker lost lock",
          workerId: undefined,
        });
        await queue.add(task.id, task.priority, Date.now());
      } else {
        await handleTaskError(task, error as Error, definition);
      }
    } finally {
      clearInterval(heartbeat);
      activeTasks.delete(task.id);
      forceStopped.delete(task.id);
      if (reservedConcurrency) {
        await concurrencyLimiter.release(task.name);
      }
      await lock.release(task.id, workerId);
    }
  };

  const poll = async (): Promise<void> => {
    while (running && !draining && !paused) {
      if (activeTasks.size >= concurrency) {
        await sleep(100);
        continue;
      }

      const task = await queue.claimNext(workerId, config.taskTypes);
      if (!task) {
        await sleep(pollInterval);
        continue;
      }

      const definition = registry.get(task.name);
      if (!definition) {
        await dlq.add(task, `Unknown task type: ${task.name}`);
        failedCount++;
        await lock.release(task.id, workerId);
        continue;
      }

      let reservedConcurrency = false;
      if (definition.maxConcurrency && definition.maxConcurrency > 0) {
        reservedConcurrency = await concurrencyLimiter.tryReserve(
          task.name,
          definition.maxConcurrency
        );
        if (!reservedConcurrency) {
          await lock.release(task.id, workerId);
          await queue.add(task.id, task.priority, Date.now());
          await sleep(pollInterval);
          continue;
        }
      }

      processTask(task, definition, reservedConcurrency).catch((err) =>
        console.error(`Task ${task.id} error:`, err)
      );
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

      for (const [taskId, controller] of activeTasks) {
        forceStopped.add(taskId);
        controller.abort();
        await storage.updateStatus(taskId, "running", "scheduled", {
          workerId: undefined,
        });
        const task = await storage.get(taskId);
        if (task) {
          await queue.add(taskId, task.priority, Date.now());
        }
        await lock.release(taskId, workerId);
      }
      activeTasks.clear();

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
