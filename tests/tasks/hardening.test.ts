import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTaskWorker, TaskWorker } from "@/tasks/worker";
import {
  createTaskScheduler,
  createTaskRegistry,
  TaskScheduler,
  TaskRegistry,
} from "@/tasks/scheduler";
import { defineTask } from "@/tasks/define";
import { createConcurrencyLimiter } from "@/tasks/concurrency";
import { createIdempotencyStore } from "@/tasks/idempotency";
import { createMemoryKV, KVAdapter } from "@/kv";
import { Task } from "@/tasks/types";

let kv: KVAdapter;
let scheduler: TaskScheduler;
let registry: TaskRegistry;
let workers: TaskWorker[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
};

describe("Task hardening", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-hardening");
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

  describe("idempotency enforcement", () => {
    it("runs the handler once across redelivery and reuses the result", async () => {
      let runCount = 0;

      const task = defineTask({
        name: "idempotent-task",
        idempotencyKey: (input: { orderId: string }) => `order:${input.orderId}`,
        handler: async () => {
          runCount++;
          return { charge: runCount };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const firstId = await scheduler.enqueue(task, { orderId: "A" });
      await waitFor(async () => {
        const t = await scheduler.getTask(firstId);
        return t?.status === "completed";
      });

      const first = await scheduler.getTask(firstId);
      expect(runCount).toBe(1);
      expect(first?.result).toEqual({ charge: 1 });

      const secondId = await scheduler.enqueue(task, { orderId: "A" });
      expect(secondId).not.toBe(firstId);

      await waitFor(async () => {
        const t = await scheduler.getTask(secondId);
        return t?.status === "completed";
      });

      const second = await scheduler.getTask(secondId);
      expect(runCount).toBe(1);
      expect(second?.result).toEqual({ charge: 1 });
    });

    it("does not re-run a completed idempotent task on at-least-once redelivery", async () => {
      let runCount = 0;

      const task = defineTask({
        name: "redeliver-task",
        idempotencyKey: () => "fixed-key",
        handler: async () => {
          runCount++;
          return { ok: true };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await waitFor(async () => {
        const t = await scheduler.getTask(taskId);
        return t?.status === "completed";
      });
      expect(runCount).toBe(1);

      const store = createIdempotencyStore(kv);
      const marker = await store.getCompleted("fixed-key");
      expect(marker?.result).toEqual({ ok: true });

      await kv.zadd("concave:tasks:queue:50", Date.now(), taskId);
      await kv.del(`concave:tasks:lock:${taskId}`);

      await sleep(200);

      expect(runCount).toBe(1);
      const after = await scheduler.getTask(taskId);
      expect(after?.status).toBe("completed");
    });
  });

  describe("per-task-type concurrency limit", () => {
    it("caps simultaneous executions of one task type while allowing others", async () => {
      let limitedActive = 0;
      let limitedMax = 0;
      let otherActive = 0;
      let otherMax = 0;

      const limited = defineTask({
        name: "limited-type",
        maxConcurrency: 2,
        handler: async () => {
          limitedActive++;
          limitedMax = Math.max(limitedMax, limitedActive);
          await sleep(120);
          limitedActive--;
        },
      });

      const other = defineTask({
        name: "other-type",
        handler: async () => {
          otherActive++;
          otherMax = Math.max(otherMax, otherActive);
          await sleep(120);
          otherActive--;
        },
      });

      registry.register(limited);
      registry.register(other);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 10,
        concurrency: 10,
      });
      workers.push(worker);
      await worker.start();

      for (let i = 0; i < 6; i++) {
        await scheduler.enqueue(limited, { i });
      }
      for (let i = 0; i < 4; i++) {
        await scheduler.enqueue(other, { i });
      }

      await waitFor(async () => {
        const completed = await scheduler.getTasks({ status: "completed" });
        return completed.length === 10;
      }, 4000);

      expect(limitedMax).toBeLessThanOrEqual(2);
      expect(otherMax).toBeGreaterThan(2);

      const limiter = createConcurrencyLimiter(kv);
      expect(await limiter.getRunning("limited-type")).toBe(0);
    });
  });

  describe("graceful drain", () => {
    it("lets an in-flight task finish and stops claiming new tasks", async () => {
      let finished = 0;
      let started = 0;

      const task = defineTask({
        name: "drain-task",
        handler: async () => {
          started++;
          await sleep(150);
          finished++;
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 10,
        concurrency: 1,
      });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, { id: "in-flight" });
      await waitFor(() => started === 1);

      const queuedId = await scheduler.enqueue(task, { id: "queued" });

      await worker.drain(2000);

      expect(finished).toBe(1);

      const queued = await scheduler.getTask(queuedId);
      expect(queued?.status === "pending" || queued?.status === "scheduled").toBe(
        true
      );
      expect(worker.getStats().status).toBe("stopped");
    });

    it("returns a hard-stopped in-flight task to a re-claimable state", async () => {
      let runs = 0;
      const completions: string[] = [];

      const task = defineTask({
        name: "hardstop-task",
        retry: { maxAttempts: 5 },
        handler: async (ctx) => {
          runs++;
          if (runs === 1) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 5000);
              ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            });
            return;
          }
          completions.push(ctx.taskId);
        },
      });
      registry.register(task);

      const worker1 = createTaskWorker(kv, registry, {
        id: "w1",
        pollIntervalMs: 10,
        concurrency: 1,
      });
      workers.push(worker1);
      await worker1.start();

      const taskId = await scheduler.enqueue(task, {});
      await waitFor(() => runs === 1);

      await worker1.stop();

      const stopped = await scheduler.getTask(taskId);
      expect(stopped?.status === "scheduled" || stopped?.status === "pending").toBe(
        true
      );
      expect(stopped?.workerId).toBeUndefined();

      const worker2 = createTaskWorker(kv, registry, {
        id: "w2",
        pollIntervalMs: 10,
        concurrency: 1,
      });
      workers.push(worker2);
      await worker2.start();

      await waitFor(async () => {
        const t = await scheduler.getTask(taskId);
        return t?.status === "completed";
      }, 3000);

      const completed = await scheduler.getTask(taskId);
      expect(completed?.status).toBe("completed");
      expect(runs).toBe(2);
      expect(completions).toContain(taskId);
    });
  });
});
