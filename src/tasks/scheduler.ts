import { KVAdapter } from "@/kv/types";
import {
  Task,
  TaskDefinition,
  TaskFilter,
  ScheduleOptions,
  RecurringConfig,
} from "./types";
import { createTaskStorage } from "./storage";
import { createTaskQueue } from "./queue";
import { createRecurringManager } from "./recurring";

const NOTIFY_CHANNEL = "covara:tasks:notify";

export interface TaskScheduler {
  enqueue<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput
  ): Promise<string>;
  schedule<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput,
    options: ScheduleOptions
  ): Promise<string>;
  scheduleRecurring<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput,
    config: RecurringConfig
  ): Promise<string>;
  cancel(taskId: string): Promise<boolean>;
  getTask(taskId: string): Promise<Task | null>;
  getTasks(filter: TaskFilter): Promise<Task[]>;
  getQueueDepth(): Promise<number>;
}

export interface TaskRegistry {
  register<TInput, TOutput>(task: TaskDefinition<TInput, TOutput>): void;
  get(name: string): TaskDefinition | undefined;
  getAll(): TaskDefinition[];
}

const isTerminal = (status: string): boolean =>
  ["completed", "failed", "dead"].includes(status);

export const createTaskRegistry = (): TaskRegistry => {
  const tasks = new Map<string, TaskDefinition>();

  return {
    register<TInput, TOutput>(task: TaskDefinition<TInput, TOutput>): void {
      tasks.set(task.name, task as TaskDefinition);
    },

    get(name: string): TaskDefinition | undefined {
      return tasks.get(name);
    },

    getAll(): TaskDefinition[] {
      return Array.from(tasks.values());
    },
  };
};

export const createTaskScheduler = (
  kv: KVAdapter,
  _registry: TaskRegistry
): TaskScheduler => {
  const storage = createTaskStorage(kv);
  const queue = createTaskQueue(kv);
  const recurring = createRecurringManager(kv);

  const enqueueTask = async (task: Task): Promise<string> => {
    await storage.store(task);
    await queue.add(task.id, task.priority, task.scheduledFor);
    await kv.publish(NOTIFY_CHANNEL, JSON.stringify({ taskId: task.id }));
    return task.id;
  };

  return {
    async enqueue<TInput>(
      taskDef: TaskDefinition<TInput>,
      input: TInput
    ): Promise<string> {
      const taskId = crypto.randomUUID();
      const now = Date.now();

      const idempotencyKey = taskDef.idempotencyKey?.(input);
      if (idempotencyKey) {
        const existing = await storage.findByIdempotencyKey(idempotencyKey);
        if (existing && !isTerminal(existing.status)) {
          return existing.id;
        }
      }

      const task: Task = {
        id: taskId,
        name: taskDef.name,
        input,
        status: "pending",
        priority: taskDef.priority ?? 50,
        createdAt: now,
        scheduledFor: now,
        attempt: 0,
        maxAttempts: taskDef.retry?.maxAttempts ?? 3,
        idempotencyKey,
      };

      return enqueueTask(task);
    },

    async schedule<TInput>(
      taskDef: TaskDefinition<TInput>,
      input: TInput,
      options: ScheduleOptions
    ): Promise<string> {
      const taskId = crypto.randomUUID();
      const now = Date.now();
      const scheduledFor = options.at?.getTime() ?? now + (options.delay ?? 0);

      const idempotencyKey =
        options.idempotencyKey ?? taskDef.idempotencyKey?.(input);
      if (idempotencyKey) {
        const existing = await storage.findByIdempotencyKey(idempotencyKey);
        if (existing && !isTerminal(existing.status)) {
          return existing.id;
        }
      }

      const task: Task = {
        id: taskId,
        name: taskDef.name,
        input,
        status: "scheduled",
        priority: options.priority ?? taskDef.priority ?? 50,
        createdAt: now,
        scheduledFor,
        attempt: 0,
        maxAttempts: taskDef.retry?.maxAttempts ?? 3,
        idempotencyKey,
      };

      return enqueueTask(task);
    },

    async scheduleRecurring<TInput>(
      taskDef: TaskDefinition<TInput>,
      input: TInput,
      config: RecurringConfig
    ): Promise<string> {
      return recurring.create(taskDef as TaskDefinition, input, config);
    },

    async cancel(taskId: string): Promise<boolean> {
      const task = await storage.get(taskId);
      if (!task) return false;

      if (isTerminal(task.status)) return false;

      if (task.status === "running") {
        return false;
      }

      await queue.remove(taskId, task.priority);
      await storage.delete(taskId);

      return true;
    },

    async getTask(taskId: string): Promise<Task | null> {
      return storage.get(taskId);
    },

    async getTasks(filter: TaskFilter): Promise<Task[]> {
      return storage.query(filter);
    },

    async getQueueDepth(): Promise<number> {
      return queue.getQueueDepth();
    },
  };
};

let globalScheduler: TaskScheduler | null = null;
let globalRegistry: TaskRegistry | null = null;

export const initializeTasks = (kv: KVAdapter): void => {
  globalRegistry = createTaskRegistry();
  globalScheduler = createTaskScheduler(kv, globalRegistry);
};

export const getTaskScheduler = (): TaskScheduler => {
  if (!globalScheduler) {
    throw new Error(
      "Task scheduler not initialized. Call initializeTasks() first."
    );
  }
  return globalScheduler;
};

export const getTaskRegistry = (): TaskRegistry => {
  if (!globalRegistry) {
    throw new Error(
      "Task registry not initialized. Call initializeTasks() first."
    );
  }
  return globalRegistry;
};
