import { KVAdapter } from "@/kv/types";
import { Task, DeadLetterEntry, DlqMetrics } from "./types";
import { createTaskStorage } from "./storage";

const DEAD_LETTER_KEY = "covara:tasks:dead";
const DLQ_DATA_PREFIX = "covara:tasks:dead:data:";
const DLQ_AUDIT_KEY = "covara:tasks:dead:audit";

const DEFAULT_RETRY_ALL_LIMIT = 100;

const serializeDLQEntry = (entry: DeadLetterEntry): Record<string, string> => {
  const data: Record<string, string> = {
    taskId: entry.taskId,
    task: JSON.stringify(entry.task),
    failedAt: String(entry.failedAt),
    reason: entry.reason,
    attempts: String(entry.attempts),
  };
  if (entry.originalTaskId !== undefined) data.originalTaskId = entry.originalTaskId;
  if (entry.replayedFromDlqAt !== undefined)
    data.replayedFromDlqAt = String(entry.replayedFromDlqAt);
  if (entry.replayedBy !== undefined) data.replayedBy = entry.replayedBy;
  if (entry.replayCount !== undefined) data.replayCount = String(entry.replayCount);
  return data;
};

const deserializeDLQEntry = (data: Record<string, string>): DeadLetterEntry => ({
  taskId: data.taskId,
  task: JSON.parse(data.task),
  failedAt: parseInt(data.failedAt, 10),
  reason: data.reason,
  attempts: parseInt(data.attempts, 10),
  ...(data.originalTaskId && { originalTaskId: data.originalTaskId }),
  ...(data.replayedFromDlqAt && {
    replayedFromDlqAt: parseInt(data.replayedFromDlqAt, 10),
  }),
  ...(data.replayedBy && { replayedBy: data.replayedBy }),
  ...(data.replayCount && { replayCount: parseInt(data.replayCount, 10) }),
});

export interface DlqReplayAuditEntry {
  originalTaskId: string;
  newTaskId: string;
  replayedAt: number;
  replayedBy?: string;
  replayCount: number;
}

export interface DlqRetryAllOptions {
  limit?: number;
  replayedBy?: string;
}

export interface DeadLetterQueueOptions {
  onDlqEnqueue?: (entry: DeadLetterEntry) => void | Promise<void>;
}

export interface DeadLetterQueue {
  add(task: Task, reason: string): Promise<void>;
  list(limit?: number, offset?: number): Promise<DeadLetterEntry[]>;
  get(taskId: string): Promise<DeadLetterEntry | null>;
  retry(taskId: string, replayedBy?: string): Promise<string | null>;
  retryAll(options?: DlqRetryAllOptions): Promise<number>;
  purge(olderThanMs?: number): Promise<number>;
  count(): Promise<number>;
  metrics(): Promise<DlqMetrics>;
  audit(limit?: number): Promise<DlqReplayAuditEntry[]>;
}

export const createDeadLetterQueue = (
  kv: KVAdapter,
  requeue: (task: Task) => Promise<string>,
  options: DeadLetterQueueOptions = {}
): DeadLetterQueue => {
  const storage = createTaskStorage(kv);

  return {
    async add(task: Task, reason: string): Promise<void> {
      const entry: DeadLetterEntry = {
        taskId: task.id,
        task,
        failedAt: Date.now(),
        reason,
        attempts: task.attempt,
        ...(task.originalTaskId !== undefined && {
          originalTaskId: task.originalTaskId,
        }),
        ...(task.replayedFromDlqAt !== undefined && {
          replayedFromDlqAt: task.replayedFromDlqAt,
        }),
        ...(task.replayedBy !== undefined && { replayedBy: task.replayedBy }),
        ...(task.replayCount !== undefined && { replayCount: task.replayCount }),
      };

      await storage.updateStatus(task.id, task.status, "dead", {
        lastError: reason,
        completedAt: Date.now(),
      });

      await kv.zadd(DEAD_LETTER_KEY, entry.failedAt, task.id);
      await kv.hmset(
        `${DLQ_DATA_PREFIX}${task.id}`,
        serializeDLQEntry(entry) as never
      );

      if (options.onDlqEnqueue) {
        try {
          await options.onDlqEnqueue(entry);
        } catch {
          // alerting hook failures must not affect DLQ persistence
        }
      }
    },

    async list(limit: number = 100, offset: number = 0): Promise<DeadLetterEntry[]> {
      const taskIds = await kv.zrange(DEAD_LETTER_KEY, offset, offset + limit - 1);
      const entries: DeadLetterEntry[] = [];

      for (const taskId of taskIds) {
        const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
        if (data && Object.keys(data).length > 0) {
          entries.push(deserializeDLQEntry(data));
        }
      }

      return entries;
    },

    async get(taskId: string): Promise<DeadLetterEntry | null> {
      const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
      if (!data || Object.keys(data).length === 0) return null;
      return deserializeDLQEntry(data);
    },

    async retry(taskId: string, replayedBy?: string): Promise<string | null> {
      const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
      if (!data || Object.keys(data).length === 0) return null;

      const entry = deserializeDLQEntry(data);

      await kv.zrem(DEAD_LETTER_KEY, taskId);
      await kv.del(`${DLQ_DATA_PREFIX}${taskId}`);
      await storage.delete(taskId);

      const newId = crypto.randomUUID();
      const originalTaskId = entry.originalTaskId ?? entry.taskId;
      const replayCount = (entry.replayCount ?? 0) + 1;
      const replayedAt = Date.now();

      const newTask: Task = {
        ...entry.task,
        id: newId,
        status: "pending",
        attempt: 0,
        createdAt: replayedAt,
        scheduledFor: replayedAt,
        startedAt: undefined,
        completedAt: undefined,
        workerId: undefined,
        lastError: undefined,
        result: undefined,
        progress: undefined,
        lastHeartbeatAt: undefined,
        resultExpiresAt: undefined,
        originalTaskId,
        replayCount,
        replayedFromDlqAt: replayedAt,
        ...(replayedBy !== undefined && { replayedBy }),
      };

      const requeuedId = await requeue(newTask);

      const auditEntry: DlqReplayAuditEntry = {
        originalTaskId,
        newTaskId: requeuedId,
        replayedAt,
        ...(replayedBy !== undefined && { replayedBy }),
        replayCount,
      };
      await kv.zadd(DLQ_AUDIT_KEY, replayedAt, JSON.stringify(auditEntry));

      return requeuedId;
    },

    async retryAll(opts: DlqRetryAllOptions = {}): Promise<number> {
      const limit = opts.limit ?? DEFAULT_RETRY_ALL_LIMIT;
      const entries = await this.list(limit);
      let retried = 0;

      for (const entry of entries) {
        const newId = await this.retry(entry.taskId, opts.replayedBy);
        if (newId) retried++;
      }

      return retried;
    },

    async purge(olderThanMs?: number): Promise<number> {
      const cutoff = olderThanMs ? Date.now() - olderThanMs : Infinity;

      const taskIds = await kv.zrangebyscore(DEAD_LETTER_KEY, "-inf", cutoff);

      for (const taskId of taskIds) {
        await kv.del(`${DLQ_DATA_PREFIX}${taskId}`);
        await storage.delete(taskId);
      }

      await kv.zrem(DEAD_LETTER_KEY, ...taskIds);

      return taskIds.length;
    },

    async count(): Promise<number> {
      return kv.zcard(DEAD_LETTER_KEY);
    },

    async metrics(): Promise<DlqMetrics> {
      const count = await kv.zcard(DEAD_LETTER_KEY);
      if (count === 0) {
        return { count: 0, oldestEntryAgeMs: null };
      }
      const [oldestId] = await kv.zrange(DEAD_LETTER_KEY, 0, 0);
      if (!oldestId) {
        return { count, oldestEntryAgeMs: null };
      }
      const score = await kv.zscore(DEAD_LETTER_KEY, oldestId);
      return {
        count,
        oldestEntryAgeMs: score === null ? null : Date.now() - score,
      };
    },

    async audit(limit: number = 100): Promise<DlqReplayAuditEntry[]> {
      const raw = await kv.zrange(DLQ_AUDIT_KEY, -limit, -1);
      return raw
        .map((item) => {
          try {
            return JSON.parse(item) as DlqReplayAuditEntry;
          } catch {
            return null;
          }
        })
        .filter((item): item is DlqReplayAuditEntry => item !== null);
    },
  };
};
