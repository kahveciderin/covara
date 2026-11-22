import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryKV, type KVAdapter } from "@/kv";
import { createTaskWorker, type TaskWorker } from "@/tasks/worker";
import { createTaskRegistry, createTaskScheduler, type TaskRegistry, type TaskScheduler } from "@/tasks/scheduler";
import { createConcurrencyLimiter } from "@/tasks/concurrency";
import { createTaskStorage } from "@/tasks/storage";
import { createTaskQueue } from "@/tasks/queue";
import { createDeadLetterQueue } from "@/tasks/dlq";
import { defineTask } from "@/tasks/define";
import type { Task, WorkerConfig } from "@/tasks/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hang = () => new Promise<never>(() => {});

// SIGKILL, as the KV sees it: the process simply stops talking.
const killable = (kv: KVAdapter) => {
  let dead = false;
  const proxy = new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => (dead ? hang() : value.apply(target, args));
    },
  });
  return { kv: proxy, kill: () => (dead = true) };
};

describe("task crash recovery", () => {
  let kv: KVAdapter;
  let registry: TaskRegistry;
  let scheduler: TaskScheduler;
  let workers: TaskWorker[];
  let kills: (() => void)[];

  beforeEach(async () => {
    kv = createMemoryKV(`crash-${crypto.randomUUID()}`);
    await kv.connect();
    registry = createTaskRegistry();
    scheduler = createTaskScheduler(kv, registry);
    workers = [];
    kills = [];
  });

  afterEach(async () => {
    for (const kill of kills) kill();
    for (const worker of workers) await worker.stop();
    await kv.disconnect();
  });

  const start = async (store: KVAdapter = kv, config: WorkerConfig = {}, definitions = registry) => {
    const worker = createTaskWorker(store, definitions, { pollIntervalMs: 20, lockTtlMs: 1000, ...config });
    await worker.start();
    return worker;
  };
  const survivor = async (config: WorkerConfig = {}) => {
    const worker = await start(kv, config);
    workers.push(worker);
    return worker;
  };

  const crashMidTask = async (maxAttempts = 3) => {
    const runs: string[] = [];
    let block = true;
    const task = defineTask({
      name: "limited",
      maxConcurrency: 1,
      timeout: 600_000,
      retry: { maxAttempts },
      handler: async (ctx, input: any) => {
        runs.push(`${input.name}#${ctx.attempt}`);
        if (block) await hang();
      },
    });
    registry.register(task);
    const id = await scheduler.enqueue(task, { name: "interrupted" });
    const victim = killable(kv);
    kills.push(victim.kill);
    await start(victim.kv);
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 3000 });
    victim.kill();
    block = false;
    return { id, runs, task };
  };

  it("frees the slot and retries the interrupted task", async () => {
    const { id, runs, task } = await crashMidTask();
    await scheduler.enqueue(task, { name: "next" });
    await survivor();
    await vi.waitFor(async () => {
      expect((await scheduler.getTask(id))?.status).toBe("completed");
      expect(runs).toEqual(expect.arrayContaining(["interrupted#2", "next#1"]));
    }, { timeout: 8000 });
  }, 12_000);

  it("dead-letters, without rerunning, a task with no attempts left", async () => {
    const { id, runs } = await crashMidTask(1);
    const alerts: string[] = [];
    await survivor({ onDlqEnqueue: (entry) => void alerts.push(entry.taskId) });
    await vi.waitFor(() => expect(alerts).toEqual([id]), { timeout: 8000 });
    expect(runs).toHaveLength(1);
    expect((await scheduler.getTask(id))?.status).toBe("dead");
    expect(await kv.smembers("covara:tasks:status:running")).toEqual([]);
    expect(await createDeadLetterQueue(kv, async () => "").count()).toBe(1);
  }, 12_000);

  it("requeues a task lost between claim and start, without spending an attempt", async () => {
    const runs: number[] = [];
    const task = defineTask({ name: "claimed", handler: async (ctx) => void runs.push(ctx.attempt) });
    registry.register(task);
    await scheduler.enqueue(task, {});
    expect(await createTaskQueue(kv).claimNext("dead-worker", undefined, 1)).not.toBeNull();
    await survivor();
    await vi.waitFor(() => expect(runs).toEqual([1]), { timeout: 8000 });
  }, 12_000);

  it("recovers a task an older version left running", async () => {
    const runs: number[] = [];
    registry.register(defineTask({ name: "orphan", handler: async (ctx) => void runs.push(ctx.attempt) }));
    await createTaskStorage(kv).store({
      id: "old",
      name: "orphan",
      input: {},
      status: "running",
      priority: 50,
      createdAt: 1,
      scheduledFor: 1,
      attempt: 0,
      maxAttempts: 3,
      workerId: "gone",
      lastHeartbeatAt: Date.now() - 120_000,
    } as Task);
    await survivor();
    await vi.waitFor(() => expect(runs).toEqual([2]), { timeout: 8000 });
  }, 12_000);

  it("leaves a Cloudflare Queues task alone", async () => {
    const handler = vi.fn(async () => {});
    registry.register(defineTask({ name: "cf", handler }));
    await createTaskStorage(kv).store({
      id: "cf1",
      name: "cf",
      input: {},
      status: "running",
      priority: 50,
      createdAt: 1,
      scheduledFor: 1,
      attempt: 0,
      maxAttempts: 3,
      startedAt: 1,
    } as Task);
    await survivor();
    await sleep(1500);
    expect(handler).not.toHaveBeenCalled();
    expect((await scheduler.getTask("cf1"))?.status).toBe("running");
  });

  it("ignores a counter that an older version left stuck", async () => {
    await kv.set("covara:tasks:concurrency:stuck", "1");
    const handler = vi.fn(async () => {});
    const task = defineTask({ name: "stuck", maxConcurrency: 1, handler });
    registry.register(task);
    await scheduler.enqueue(task, {});
    await survivor();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("does not reclaim, or exceed the cap for, live tasks that outlast the lease", async () => {
    let active = 0;
    let peak = 0;
    const attempts: number[] = [];
    const task = defineTask({
      name: "long",
      maxConcurrency: 1,
      timeout: 10_000,
      handler: async (ctx) => {
        attempts.push(ctx.attempt);
        peak = Math.max(peak, ++active);
        await sleep(2600);
        active--;
      },
    });
    registry.register(task);
    await scheduler.enqueue(task, { n: 1 });
    await scheduler.enqueue(task, { n: 2 });
    await survivor();
    await survivor();
    await vi.waitFor(async () => expect(await scheduler.getTasks({ status: "completed" })).toHaveLength(2), { timeout: 10_000 });
    expect(peak).toBe(1);
    expect(attempts).toEqual([1, 1]);
  }, 14_000);

  it("stop() frees the slot at once and spends no attempt", async () => {
    const runs: number[] = [];
    let block = true;
    const task = defineTask({
      name: "stopped",
      maxConcurrency: 1,
      timeout: 600_000,
      handler: async (ctx) => {
        runs.push(ctx.attempt);
        if (block) await hang();
      },
    });
    registry.register(task);
    await scheduler.enqueue(task, {});
    const first = await start(kv, { lockTtlMs: 30_000 });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await first.stop();
    expect(await createConcurrencyLimiter(kv).getRunning("stopped")).toBe(0);
    block = false;
    await survivor({ lockTtlMs: 30_000 });
    await vi.waitFor(() => expect(runs).toEqual([1, 1]), { timeout: 2000 });
  });

  it("does not start a task whose claim finished after stop()", async () => {
    const handler = vi.fn(async () => {});
    const task = defineTask({ name: "late", handler });
    registry.register(task);
    const id = await scheduler.enqueue(task, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = false;
    const slow = new Proxy(kv, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "hgetall" && !waiting) {
          return async (key: string) => {
            waiting = true;
            await gate;
            return kv.hgetall(key);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = await start(slow);
    await vi.waitFor(() => expect(waiting).toBe(true));
    await worker.stop();
    release();
    await sleep(100);
    expect(handler).not.toHaveBeenCalled();
    expect(await createTaskQueue(kv).getScheduledTasks()).toEqual([id]);
  });

  it("keeps polling through a KV outage", async () => {
    let down = true;
    const flaky = new Proxy(kv, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "zrangebyscore" && down) return async () => Promise.reject(new Error("ECONNRESET"));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = vi.fn(async () => {});
    const task = defineTask({ name: "outage", handler });
    registry.register(task);
    await scheduler.enqueue(task, {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    workers.push(await start(flaky));
    await sleep(100);
    down = false;
    await vi.waitFor(() => expect(handler).toHaveBeenCalled(), { timeout: 3000 });
    log.mockRestore();
  });

  it("a worker that lost its lock leaves the task to the new owner", async () => {
    let running = false;
    const task = defineTask({
      name: "lost",
      timeout: 10_000,
      handler: async (ctx) => {
        running = true;
        await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    });
    registry.register(task);
    const id = await scheduler.enqueue(task, {});
    const worker = await survivor();
    await vi.waitFor(() => expect(running).toBe(true));
    await kv.set(`covara:tasks:lock:${id}`, "new-owner", { ex: 30 });
    await vi.waitFor(() => expect(worker.getStats().activeTasks).toBe(0), { timeout: 3000 });
    expect((await scheduler.getTask(id))?.status).toBe("running");
    expect(await createTaskQueue(kv).getScheduledTasks()).toEqual([]);
  });

  it.each(["sent", "123", { ok: true }, 7, null])("stores a handler result of %j readably", async (result) => {
    const task = defineTask({ name: "result", handler: async () => result });
    registry.register(task);
    const id = await scheduler.enqueue(task, {});
    await survivor();
    await vi.waitFor(async () => expect((await scheduler.getTask(id))?.status).toBe("completed"), { timeout: 3000 });
    expect((await scheduler.getTask(id))?.result).toEqual(result);
  });

  it("reads a result that an older version stored unencoded", async () => {
    const storage = createTaskStorage(kv);
    await storage.store({ id: "r", name: "r", input: {}, status: "completed", priority: 50, createdAt: 1, scheduledFor: 1, attempt: 0, maxAttempts: 1 });
    await kv.hset("covara:tasks:data:r", "result", "sent");
    expect((await storage.get("r"))?.result).toBe("sent");
  });

  it.each([0, 80])("resume() after %ims paused picks up work again", async (pausedFor) => {
    const handler = vi.fn(async () => {});
    const task = defineTask({ name: "paused", handler });
    registry.register(task);
    const worker = await survivor();
    worker.pause();
    if (pausedFor) await sleep(pausedFor);
    worker.resume();
    await scheduler.enqueue(task, {});
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("finished tasks leave no in-flight or running entries", async () => {
    const ok = defineTask({ name: "ok", handler: async () => ({}) });
    const bad = defineTask({
      name: "bad",
      retry: { maxAttempts: 1 },
      handler: async () => {
        throw new Error("no");
      },
    });
    registry.register(ok);
    registry.register(bad);
    await scheduler.enqueue(ok, {});
    await scheduler.enqueue(bad, {});
    const worker = await survivor();
    await vi.waitFor(() => {
      expect(worker.getStats().processedCount + worker.getStats().failedCount).toBe(2);
      expect(worker.getStats().activeTasks).toBe(0);
    });
    await sleep(20);
    expect(await kv.smembers("covara:tasks:status:running")).toEqual([]);
    expect(await kv.zcard("covara:tasks:inflight")).toBe(0);
  });
});

describe("concurrency limiter leases", () => {
  let kv: KVAdapter;
  beforeEach(async () => {
    kv = createMemoryKV(`lease-${crypto.randomUUID()}`);
    await kv.connect();
  });
  afterEach(() => kv.disconnect());

  it("never admits more than the cap under a race", async () => {
    const limiters = Array.from({ length: 10 }, () => createConcurrencyLimiter(kv));
    const admitted = await Promise.all(limiters.map((l) => l.tryReserve("x", 3)));
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(await limiters[0].getRunning("x")).toBe(3);
    await Promise.all(limiters.map((l) => l.release("x")));
    expect(await limiters[0].getRunning("x")).toBe(0);
  });

  it("renews a held lease until it is released", async () => {
    const holder = createConcurrencyLimiter(kv, { leaseMs: 1000 });
    expect(await holder.tryReserve("x", 1)).toBe(true);
    await sleep(2300);
    expect(await createConcurrencyLimiter(kv).tryReserve("x", 1)).toBe(false);
    await holder.release("x");
    const next = createConcurrencyLimiter(kv);
    expect(await next.tryReserve("x", 1)).toBe(true);
    await next.release("x");
  });

  it("expires the lease of a holder that died", async () => {
    const victim = killable(kv);
    expect(await createConcurrencyLimiter(victim.kv, { leaseMs: 1000 }).tryReserve("x", 1)).toBe(true);
    victim.kill();
    await sleep(1400);
    const next = createConcurrencyLimiter(kv);
    expect(await next.getRunning("x")).toBe(0);
    expect(await next.tryReserve("x", 1)).toBe(true);
    await next.release("x");
  });

  it("releasing more than was reserved cannot raise the cap", async () => {
    const limiter = createConcurrencyLimiter(kv);
    await limiter.release("x");
    expect(await limiter.tryReserve("x", 1)).toBe(true);
    expect(await limiter.tryReserve("x", 1)).toBe(false);
    await limiter.release("x");
  });

  it("a cap of zero is unlimited", async () => {
    expect(await createConcurrencyLimiter(kv).tryReserve("x", 0)).toBe(true);
  });
});
