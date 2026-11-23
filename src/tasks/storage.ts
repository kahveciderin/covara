import { KVAdapter } from "@/kv/types";
import { Task, TaskStatus, TaskFilter, TaskProgress } from "./types";

const TASK_DATA_PREFIX = "covara:tasks:data:";
const STATUS_INDEX_PREFIX = "covara:tasks:status:";
const NAME_INDEX_PREFIX = "covara:tasks:name:";
const IDEMPOTENCY_PREFIX = "covara:tasks:idempotency:";
const EXPIRING_KEY = "covara:tasks:expiring";
const EXPIRY_SWEEP_BATCH = 100;
const TERMINAL_WITH_RESULT: TaskStatus[] = ["completed", "failed"];

const serializeTask = (task: Task): Record<string, string> => {
  const result: Record<string, string> = {
    id: task.id,
    name: task.name,
    input: JSON.stringify(task.input),
    status: task.status,
    priority: String(task.priority),
    createdAt: String(task.createdAt),
    scheduledFor: String(task.scheduledFor),
    attempt: String(task.attempt),
    maxAttempts: String(task.maxAttempts),
  };
  if (task.startedAt !== undefined) result.startedAt = String(task.startedAt);
  if (task.completedAt !== undefined) result.completedAt = String(task.completedAt);
  if (task.workerId !== undefined) result.workerId = task.workerId;
  if (task.lastError !== undefined) result.lastError = task.lastError;
  if (task.result !== undefined) result.result = JSON.stringify(task.result);
  if (task.idempotencyKey !== undefined) result.idempotencyKey = task.idempotencyKey;
  if (task.recurring !== undefined) result.recurring = JSON.stringify(task.recurring);
  if (task.progress !== undefined) result.progress = JSON.stringify(task.progress);
  if (task.lastHeartbeatAt !== undefined)
    result.lastHeartbeatAt = String(task.lastHeartbeatAt);
  if (task.resultExpiresAt !== undefined)
    result.resultExpiresAt = String(task.resultExpiresAt);
  if (task.originalTaskId !== undefined) result.originalTaskId = task.originalTaskId;
  if (task.replayCount !== undefined) result.replayCount = String(task.replayCount);
  if (task.replayedFromDlqAt !== undefined)
    result.replayedFromDlqAt = String(task.replayedFromDlqAt);
  if (task.replayedBy !== undefined) result.replayedBy = task.replayedBy;
  return result;
};

// Results written before 0.17.3 stored strings unencoded.
const parseResult = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const deserializeTask = (data: Record<string, string>): Task => ({
  id: data.id,
  name: data.name,
  input: JSON.parse(data.input),
  status: data.status as TaskStatus,
  priority: parseInt(data.priority, 10),
  createdAt: parseInt(data.createdAt, 10),
  scheduledFor: parseInt(data.scheduledFor, 10),
  attempt: parseInt(data.attempt, 10),
  maxAttempts: parseInt(data.maxAttempts, 10),
  ...(data.startedAt && { startedAt: parseInt(data.startedAt, 10) }),
  ...(data.completedAt && { completedAt: parseInt(data.completedAt, 10) }),
  ...(data.workerId && { workerId: data.workerId }),
  ...(data.lastError && { lastError: data.lastError }),
  ...(data.result && { result: parseResult(data.result) }),
  ...(data.idempotencyKey && { idempotencyKey: data.idempotencyKey }),
  ...(data.recurring && { recurring: JSON.parse(data.recurring) }),
  ...(data.progress && { progress: JSON.parse(data.progress) }),
  ...(data.lastHeartbeatAt && {
    lastHeartbeatAt: parseInt(data.lastHeartbeatAt, 10),
  }),
  ...(data.resultExpiresAt && {
    resultExpiresAt: parseInt(data.resultExpiresAt, 10),
  }),
  ...(data.originalTaskId && { originalTaskId: data.originalTaskId }),
  ...(data.replayCount && { replayCount: parseInt(data.replayCount, 10) }),
  ...(data.replayedFromDlqAt && {
    replayedFromDlqAt: parseInt(data.replayedFromDlqAt, 10),
  }),
  ...(data.replayedBy && { replayedBy: data.replayedBy }),
});

const matchesFilter = (task: Task, filter: TaskFilter): boolean => {
  if (filter.createdAfter && task.createdAt < filter.createdAfter.getTime()) {
    return false;
  }
  if (filter.createdBefore && task.createdAt > filter.createdBefore.getTime()) {
    return false;
  }
  return true;
};

export interface TaskStorage {
  store(task: Task): Promise<void>;
  get(taskId: string): Promise<Task | null>;
  update(taskId: string, updates: Partial<Task>): Promise<void>;
  updateStatus(
    taskId: string,
    oldStatus: TaskStatus,
    newStatus: TaskStatus,
    updates?: Partial<Task>
  ): Promise<void>;
  delete(taskId: string): Promise<void>;
  query(filter: TaskFilter): Promise<Task[]>;
  findByIdempotencyKey(key: string): Promise<Task | null>;
  setIdempotencyKey(key: string, taskId: string, ttlMs: number): Promise<void>;
  setProgress(taskId: string, progress: TaskProgress): Promise<void>;
  getProgress(taskId: string): Promise<TaskProgress | null>;
  setHeartbeat(taskId: string, at: number): Promise<void>;
}

// The record itself carries a KV TTL; this drops its index entries once expired.
const sweepExpired = async (kv: KVAdapter): Promise<void> => {
  const now = Date.now();
  const due = await kv.zrangebyscore(EXPIRING_KEY, "-inf", now, {
    limit: { offset: 0, count: EXPIRY_SWEEP_BATCH },
  });
  for (const member of due) {
    const [taskId, name] = JSON.parse(member) as [string, string];
    const dataKey = `${TASK_DATA_PREFIX}${taskId}`;
    const multi = kv.multi();
    multi.zrem(EXPIRING_KEY, member);
    const [status, expiresAt] = await Promise.all([kv.hget(dataKey, "status"), kv.hget(dataKey, "resultExpiresAt")]);
    const live = status !== null && !(TERMINAL_WITH_RESULT.includes(status as TaskStatus) && Number(expiresAt) <= now);
    if (!live) {
      multi.del(dataKey);
      for (const terminal of TERMINAL_WITH_RESULT) multi.srem(`${STATUS_INDEX_PREFIX}${terminal}`, taskId);
      if (name) multi.srem(`${NAME_INDEX_PREFIX}${name}`, taskId);
    }
    await multi.exec();
  }
};

export const createTaskStorage = (kv: KVAdapter): TaskStorage => ({
  async store(task: Task): Promise<void> {
    await kv.hmset(`${TASK_DATA_PREFIX}${task.id}`, serializeTask(task));

    const multi = kv.multi();
    multi.sadd(`${STATUS_INDEX_PREFIX}${task.status}`, task.id);
    multi.sadd(`${NAME_INDEX_PREFIX}${task.name}`, task.id);
    await multi.exec();

    if (task.idempotencyKey) {
      const ttl = 24 * 60 * 60;
      await kv.set(`${IDEMPOTENCY_PREFIX}${task.idempotencyKey}`, task.id, {
        ex: ttl,
      });
    }
  },

  async get(taskId: string): Promise<Task | null> {
    const data = await kv.hgetall(`${TASK_DATA_PREFIX}${taskId}`);
    if (!data || Object.keys(data).length === 0) return null;
    const task = deserializeTask(data);

    if (
      task.resultExpiresAt !== undefined &&
      Date.now() >= task.resultExpiresAt &&
      (task.status === "completed" || task.status === "failed")
    ) {
      await this.delete(taskId);
      return null;
    }

    return task;
  },

  async update(taskId: string, updates: Partial<Task>): Promise<void> {
    const existing = await this.get(taskId);
    if (!existing) return;

    const updated = { ...existing, ...updates };
    const multi = kv.multi();

    for (const [key, value] of Object.entries(serializeTask(updated))) {
      multi.hset(`${TASK_DATA_PREFIX}${taskId}`, key, value);
    }

    await multi.exec();
  },

  async updateStatus(
    taskId: string,
    oldStatus: TaskStatus,
    newStatus: TaskStatus,
    updates: Partial<Task> = {}
  ): Promise<void> {
    const multi = kv.multi();

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        multi.hdel(`${TASK_DATA_PREFIX}${taskId}`, key);
        continue;
      }
      const serialized =
        key === "result" || typeof value === "object" ? JSON.stringify(value) : String(value);
      multi.hset(`${TASK_DATA_PREFIX}${taskId}`, key, serialized);
    }
    multi.hset(`${TASK_DATA_PREFIX}${taskId}`, "status", newStatus);

    multi.srem(`${STATUS_INDEX_PREFIX}${oldStatus}`, taskId);
    multi.sadd(`${STATUS_INDEX_PREFIX}${newStatus}`, taskId);

    const expiresAt = updates.resultExpiresAt;
    const expires = typeof expiresAt === "number" && TERMINAL_WITH_RESULT.includes(newStatus);
    if (expires) {
      const name = await kv.hget(`${TASK_DATA_PREFIX}${taskId}`, "name");
      multi.expire(`${TASK_DATA_PREFIX}${taskId}`, Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)));
      multi.zadd(EXPIRING_KEY, expiresAt, JSON.stringify([taskId, name ?? ""]));
    }

    await multi.exec();

    if (expires) await sweepExpired(kv).catch(() => undefined);
  },

  async delete(taskId: string): Promise<void> {
    const data = await kv.hgetall(`${TASK_DATA_PREFIX}${taskId}`);
    if (!data || Object.keys(data).length === 0) return;
    const task = deserializeTask(data);

    const multi = kv.multi();
    multi.del(`${TASK_DATA_PREFIX}${taskId}`);
    multi.srem(`${STATUS_INDEX_PREFIX}${task.status}`, taskId);
    multi.srem(`${NAME_INDEX_PREFIX}${task.name}`, taskId);
    await multi.exec();

    if (task.idempotencyKey) {
      await kv.del(`${IDEMPOTENCY_PREFIX}${task.idempotencyKey}`);
    }
  },

  async query(filter: TaskFilter): Promise<Task[]> {
    let taskIds: string[] = [];

    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      for (const status of statuses) {
        const ids = await kv.smembers(`${STATUS_INDEX_PREFIX}${status}`);
        taskIds.push(...ids);
      }
    }

    if (filter.name) {
      const names = Array.isArray(filter.name) ? filter.name : [filter.name];
      const nameIds: string[] = [];
      for (const name of names) {
        const ids = await kv.smembers(`${NAME_INDEX_PREFIX}${name}`);
        nameIds.push(...ids);
      }
      taskIds = taskIds.length
        ? taskIds.filter((id) => nameIds.includes(id))
        : nameIds;
    }

    if (!filter.status && !filter.name) {
      const allStatuses: TaskStatus[] = [
        "pending",
        "scheduled",
        "running",
        "completed",
        "failed",
        "dead",
      ];
      for (const status of allStatuses) {
        const ids = await kv.smembers(`${STATUS_INDEX_PREFIX}${status}`);
        taskIds.push(...ids);
      }
    }

    const uniqueIds = [...new Set(taskIds)];
    const tasks: Task[] = [];

    for (const id of uniqueIds) {
      const task = await this.get(id);
      if (task && matchesFilter(task, filter)) {
        tasks.push(task);
      }
    }

    return tasks
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100));
  },

  async findByIdempotencyKey(key: string): Promise<Task | null> {
    const taskId = await kv.get(`${IDEMPOTENCY_PREFIX}${key}`);
    if (!taskId) return null;
    return this.get(taskId);
  },

  async setIdempotencyKey(
    key: string,
    taskId: string,
    ttlMs: number
  ): Promise<void> {
    await kv.set(`${IDEMPOTENCY_PREFIX}${key}`, taskId, {
      ex: Math.ceil(ttlMs / 1000),
    });
  },

  async setProgress(taskId: string, progress: TaskProgress): Promise<void> {
    await kv.hset(
      `${TASK_DATA_PREFIX}${taskId}`,
      "progress",
      JSON.stringify(progress)
    );
  },

  async getProgress(taskId: string): Promise<TaskProgress | null> {
    const raw = await kv.hget(`${TASK_DATA_PREFIX}${taskId}`, "progress");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TaskProgress;
    } catch {
      return null;
    }
  },

  async setHeartbeat(taskId: string, at: number): Promise<void> {
    await kv.hset(`${TASK_DATA_PREFIX}${taskId}`, "lastHeartbeatAt", String(at));
  },
});
