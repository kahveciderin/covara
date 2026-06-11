import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createTaskWorker,
  startTaskWorkers,
  TaskWorker,
} from "@/tasks/worker";
import {
  createTaskScheduler,
  createTaskRegistry,
  TaskScheduler,
  TaskRegistry,
} from "@/tasks/scheduler";
import { defineTask } from "@/tasks/define";
import { createMemoryKV, KVAdapter } from "@/kv";

let kv: KVAdapter;
let scheduler: TaskScheduler;
let registry: TaskRegistry;
let workers: TaskWorker[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TaskWorker", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-worker");
    await kv.connect();
  });

  afterAll(async () => {
    for (const worker of workers) {
      await worker.stop();
    }
    await kv.disconnect();
  });

  beforeEach(async () => {
    for (const worker of workers) {
      await worker.stop();
    }
    workers = [];

    registry = createTaskRegistry();
    scheduler = createTaskScheduler(kv, registry);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("basic processing", () => {
    it("should process a simple task", async () => {
      let processed = false;

      const task = defineTask({
        name: "simple-process",
        handler: async () => {
          processed = true;
          return { done: true };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 50,
        concurrency: 1,
      });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, {});
      await sleep(200);

      expect(processed).toBe(true);
    });

    it("should pass input to handler", async () => {
      let receivedInput: unknown;

      const task = defineTask({
        name: "input-test",
        handler: async (ctx, input) => {
          receivedInput = input;
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 50 });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, { userId: "user-1", action: "test" });
      await sleep(200);

      expect(receivedInput).toEqual({ userId: "user-1", action: "test" });
    });

    it("should provide task context to handler", async () => {
      let capturedCtx: {
        taskId: string;
        attempt: number;
        workerId: string;
        scheduledAt: Date;
        startedAt: Date;
        signal: AbortSignal;
      } | null = null;

      const task = defineTask({
        name: "context-test",
        handler: async (ctx) => {
          capturedCtx = ctx;
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        id: "test-worker-1",
        pollIntervalMs: 50,
      });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(200);

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx?.taskId).toBe(taskId);
      expect(capturedCtx?.attempt).toBe(1);
      expect(capturedCtx?.workerId).toContain("test-worker-1");
      expect(capturedCtx?.scheduledAt).toBeInstanceOf(Date);
      expect(capturedCtx?.startedAt).toBeInstanceOf(Date);
      expect(capturedCtx?.signal).toBeInstanceOf(AbortSignal);
    });

    it("should update task status to completed on success", async () => {
      const task = defineTask({
        name: "complete-status",
        handler: async () => ({ result: "success" }),
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 50 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(200);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.status).toBe("completed");
      expect(stored?.result).toEqual({ result: "success" });
      expect(stored?.completedAt).toBeDefined();
    });

    it("should store task result", async () => {
      const task = defineTask({
        name: "result-test",
        handler: async () => ({ computed: 42, items: [1, 2, 3] }),
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 50 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(200);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.result).toEqual({ computed: 42, items: [1, 2, 3] });
    });
  });

  describe("concurrency", () => {
    it("should process multiple tasks concurrently", async () => {
      const startTimes: number[] = [];
      const endTimes: number[] = [];

      const task = defineTask({
        name: "concurrent-task",
        handler: async () => {
          startTimes.push(Date.now());
          await sleep(100);
          endTimes.push(Date.now());
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 20,
        concurrency: 3,
      });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, { id: 1 });
      await scheduler.enqueue(task, { id: 2 });
      await scheduler.enqueue(task, { id: 3 });
      await sleep(300);

      expect(startTimes.length).toBe(3);
      expect(endTimes.length).toBe(3);

      const firstStart = Math.min(...startTimes);
      const lastStart = Math.max(...startTimes);
      expect(lastStart - firstStart).toBeLessThan(100);
    });

    it("should respect concurrency limit", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = defineTask({
        name: "limit-test",
        handler: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(100);
          concurrent--;
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 20,
        concurrency: 2,
      });
      workers.push(worker);
      await worker.start();

      for (let i = 0; i < 5; i++) {
        await scheduler.enqueue(task, { id: i });
      }
      await sleep(600);

      expect(maxConcurrent).toBe(2);
    });
  });

  describe("retry and failure handling", () => {
    it("should retry failed tasks", async () => {
      let attempts = 0;

      const task = defineTask({
        name: "retry-test",
        retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 50 },
        handler: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("Temporary failure");
          }
          return { success: true };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(500);

      expect(attempts).toBe(3);
      const stored = await scheduler.getTask(taskId);
      expect(stored?.status).toBe("completed");
    });

    it("should mark task as dead after max retries", async () => {
      const task = defineTask({
        name: "dead-test",
        retry: { maxAttempts: 2, backoff: "fixed", initialDelayMs: 30 },
        handler: async () => {
          throw new Error("Always fails");
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      
      // Wait for task to be processed: initial run + 2 retries with 30ms delay each + buffer
      // Need more time when system is under load from parallel test execution
      await sleep(800);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.status).toBe("dead");
      expect(stored?.lastError).toBe("Always fails");
    });

    it("should store error message on failure", async () => {
      const task = defineTask({
        name: "error-message",
        retry: { maxAttempts: 1 },
        handler: async () => {
          throw new Error("Specific error message");
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(200);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.lastError).toBe("Specific error message");
    });
  });

  describe("timeout", () => {
    it("should timeout long-running tasks", async () => {
      const task = defineTask({
        name: "timeout-test",
        timeout: 100,
        retry: { maxAttempts: 1 },
        handler: async () => {
          await sleep(500);
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(300);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.lastError).toBe("Task timeout");
    });
  });

  describe("task type filtering", () => {
    it("should only process specified task types", async () => {
      let task1Processed = false;
      let task2Processed = false;

      const task1 = defineTask({
        name: "type-1",
        handler: async () => {
          task1Processed = true;
        },
      });
      const task2 = defineTask({
        name: "type-2",
        handler: async () => {
          task2Processed = true;
        },
      });
      registry.register(task1);
      registry.register(task2);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 50,
        taskTypes: ["type-1"],
      });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task1, {});
      await scheduler.enqueue(task2, {});
      await sleep(200);

      expect(task1Processed).toBe(true);
      expect(task2Processed).toBe(false);
    });
  });

  describe("worker controls", () => {
    it("should pause processing and report paused status", async () => {
      const task = defineTask({
        name: "pause-status",
        handler: async () => {
          await sleep(50);
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 30 });
      workers.push(worker);
      await worker.start();

      expect(worker.getStats().status).toBe("running");

      worker.pause();
      expect(worker.getStats().status).toBe("paused");

      worker.resume();
      expect(worker.getStats().status).toBe("running");
    });

    it("should provide accurate stats", async () => {
      let shouldFail = true;

      const task = defineTask({
        name: "stats-test",
        retry: { maxAttempts: 1 },
        handler: async () => {
          if (shouldFail) {
            throw new Error("Fail");
          }
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        id: "stats-worker",
        pollIntervalMs: 30,
      });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, {});
      await sleep(100);

      shouldFail = false;
      await scheduler.enqueue(task, {});
      await sleep(100);

      const stats = worker.getStats();
      expect(stats.id).toContain("stats-worker");
      expect(stats.status).toBe("running");
      expect(stats.processedCount).toBe(1);
      expect(stats.failedCount).toBe(1);
      expect(stats.uptime).toBeGreaterThan(0);
    });

    it("should stop gracefully", async () => {
      let completed = false;

      const task = defineTask({
        name: "stop-test",
        handler: async () => {
          await sleep(100);
          completed = true;
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      await worker.start();

      await scheduler.enqueue(task, {});
      await sleep(50);
      await worker.stop();

      const stats = worker.getStats();
      expect(stats.status).toBe("stopped");
    });
  });

  describe("startTaskWorkers", () => {
    it("should start multiple workers", async () => {
      const task = defineTask({
        name: "multi-worker",
        handler: async () => {},
      });
      registry.register(task);

      const createdWorkers = await startTaskWorkers(kv, registry, 3, {
        pollIntervalMs: 50,
      });
      workers.push(...createdWorkers);

      expect(createdWorkers).toHaveLength(3);

      for (const worker of createdWorkers) {
        const stats = worker.getStats();
        expect(stats.status).toBe("running");
      }
    });
  });

  describe("unknown task handling", () => {
    it("should send unknown tasks to dead letter queue", async () => {
      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 30 });
      workers.push(worker);
      await worker.start();

      const unknownTask = defineTask({
        name: "unknown-task",
        handler: async () => {},
      });

      const taskId = await scheduler.enqueue(unknownTask, {});
      await sleep(200);

      const stored = await scheduler.getTask(taskId);
      expect(stored?.status).toBe("dead");
      expect(stored?.lastError).toContain("Unknown task type");
    });
  });

  describe("race condition prevention", () => {
    it("should only execute a task once with multiple workers", async () => {
      let executionCount = 0;

      const task = defineTask({
        name: "race-test",
        handler: async () => {
          executionCount++;
          await sleep(100);
          return { done: true };
        },
      });
      registry.register(task);

      const createdWorkers = await startTaskWorkers(kv, registry, 3, {
        pollIntervalMs: 10,
        concurrency: 5,
      });
      workers.push(...createdWorkers);

      await scheduler.enqueue(task, {});
      await sleep(300);

      expect(executionCount).toBe(1);
    });

    it("should not reprocess a completed task if it ends up in queue again", async () => {
      let executionCount = 0;

      const task = defineTask({
        name: "completed-requeue-test",
        handler: async () => {
          executionCount++;
          return { done: true };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(150);

      expect(executionCount).toBe(1);

      const storedTask = await scheduler.getTask(taskId);
      expect(storedTask?.status).toBe("completed");

      await kv.zadd("concave:tasks:queue:50", Date.now(), taskId);
      await sleep(150);

      expect(executionCount).toBe(1);
    });
  });
});
