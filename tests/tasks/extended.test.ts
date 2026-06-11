import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { createDeadLetterQueue, DeadLetterQueue } from "@/tasks/dlq";
import { createTaskStorage, TaskStorage } from "@/tasks/storage";
import {
  createRecurringManager,
  computeMissedOccurrences,
  RecurringManager,
} from "@/tasks/recurring";
import {
  createTaskWorker,
  TaskWorker,
} from "@/tasks/worker";
import {
  createTaskScheduler,
  createTaskRegistry,
  TaskScheduler,
  TaskRegistry,
} from "@/tasks/scheduler";
import { defineTask } from "@/tasks/define";
import {
  createQueueConsumer,
  createCloudflareQueueProducer,
  QueueTaskMessage,
  QueueMessageLike,
  MessageBatchLike,
  QueueBindingLike,
} from "@/tasks/cloudflare-queues";
import { createMemoryKV, KVAdapter } from "@/kv";
import { Task, DeadLetterEntry } from "@/tasks/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createTestTask = (overrides: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  name: "test-task",
  input: { data: "test" },
  status: "failed",
  priority: 50,
  createdAt: Date.now(),
  scheduledFor: Date.now(),
  attempt: 3,
  maxAttempts: 3,
  lastError: "Test error",
  ...overrides,
});

const clearKv = async (kv: KVAdapter) => {
  const allKeys = await kv.keys("*");
  for (const key of allKeys) await kv.del(key);
};

const makeFakeMessage = <T>(
  body: T,
  attempts = 1
): QueueMessageLike<T> & { acked: boolean; retried: boolean; retryDelay?: number } => {
  const msg = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: false,
    retryDelay: undefined as number | undefined,
    ack() {
      this.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      this.retried = true;
      this.retryDelay = options?.delaySeconds;
    },
  };
  return msg;
};

const makeBatch = <T>(
  messages: QueueMessageLike<T>[]
): MessageBatchLike<T> => ({
  queue: "test-queue",
  messages,
});

describe("Extended task features", () => {
  describe("DLQ replay lineage + alerting", () => {
    let kv: KVAdapter;
    let storage: TaskStorage;
    let dlq: DeadLetterQueue;
    let requeued: Task[];
    let alerts: DeadLetterEntry[];

    beforeAll(async () => {
      kv = createMemoryKV("test-ext-dlq");
      await kv.connect();
    });
    afterAll(async () => {
      await kv.disconnect();
    });

    beforeEach(async () => {
      await clearKv(kv);
      storage = createTaskStorage(kv);
      requeued = [];
      alerts = [];
      dlq = createDeadLetterQueue(
        kv,
        async (task) => {
          requeued.push(task);
          await storage.store(task);
          return task.id;
        },
        { onDlqEnqueue: (entry) => void alerts.push(entry) }
      );
    });

    it("fires onDlqEnqueue when a task lands in the DLQ", async () => {
      const task = createTestTask();
      await storage.store(task);

      await dlq.add(task, "boom");

      expect(alerts).toHaveLength(1);
      expect(alerts[0].taskId).toBe(task.id);
      expect(alerts[0].reason).toBe("boom");
    });

    it("preserves originalTaskId and increments replay count across replays", async () => {
      const task = createTestTask({ id: "orig-1" });
      await storage.store(task);
      await dlq.add(task, "fail 1");

      const newId1 = await dlq.retry("orig-1", "alice");
      expect(newId1).not.toBeNull();
      expect(newId1).not.toBe("orig-1");

      const replayed1 = requeued[0];
      expect(replayed1.originalTaskId).toBe("orig-1");
      expect(replayed1.replayCount).toBe(1);
      expect(replayed1.replayedBy).toBe("alice");
      expect(replayed1.status).toBe("pending");
      expect(replayed1.attempt).toBe(0);

      // Replayed task fails again -> DLQ entry should carry lineage
      const failedAgain: Task = { ...replayed1, status: "running", attempt: 3 };
      await dlq.add(failedAgain, "fail 2");

      const entry = await dlq.get(failedAgain.id);
      expect(entry?.originalTaskId).toBe("orig-1");
      expect(entry?.replayCount).toBe(1);

      // Replay a second time -> replayCount increments to 2, origin preserved
      const newId2 = await dlq.retry(failedAgain.id, "bob");
      const replayed2 = requeued[1];
      expect(newId2).toBe(replayed2.id);
      expect(replayed2.originalTaskId).toBe("orig-1");
      expect(replayed2.replayCount).toBe(2);
      expect(replayed2.replayedBy).toBe("bob");
    });

    it("records a replay audit trail", async () => {
      const task = createTestTask({ id: "audit-1" });
      await storage.store(task);
      await dlq.add(task, "err");

      await dlq.retry("audit-1", "operator");

      const audit = await dlq.audit();
      expect(audit).toHaveLength(1);
      expect(audit[0].originalTaskId).toBe("audit-1");
      expect(audit[0].replayedBy).toBe("operator");
      expect(audit[0].replayCount).toBe(1);
    });

    it("exposes DLQ metrics (count + oldest age)", async () => {
      const empty = await dlq.metrics();
      expect(empty.count).toBe(0);
      expect(empty.oldestEntryAgeMs).toBeNull();

      const old = createTestTask({ id: "m-old" });
      await storage.store(old);
      await dlq.add(old, "old");
      await sleep(20);
      const recent = createTestTask({ id: "m-new" });
      await storage.store(recent);
      await dlq.add(recent, "new");

      const metrics = await dlq.metrics();
      expect(metrics.count).toBe(2);
      expect(metrics.oldestEntryAgeMs).toBeGreaterThanOrEqual(15);
    });

    it("bounds retryAll via limit", async () => {
      for (let i = 0; i < 10; i++) {
        const t = createTestTask({ id: `bulk-${i}`, name: `bulk-${i}` });
        await storage.store(t);
        await dlq.add(t, `e${i}`);
      }

      const retried = await dlq.retryAll({ limit: 3, replayedBy: "auditor" });
      expect(retried).toBe(3);
      expect(requeued).toHaveLength(3);

      const audit = await dlq.audit();
      expect(audit).toHaveLength(3);
      expect(audit.every((a) => a.replayedBy === "auditor")).toBe(true);

      expect(await dlq.count()).toBe(7);
    });
  });

  describe("Cron DST / missed-run catchup", () => {
    let kv: KVAdapter;
    let manager: RecurringManager;

    beforeAll(async () => {
      kv = createMemoryKV("test-ext-recurring");
      await kv.connect();
    });
    afterAll(async () => {
      await kv.disconnect();
    });
    beforeEach(async () => {
      await clearKv(kv);
      manager = createRecurringManager(kv);
    });

    it("computeMissedOccurrences counts intervals between last run and now", () => {
      const start = 1_000_000;
      const missed = computeMissedOccurrences(
        { interval: 100 },
        start,
        start + 550
      );
      expect(missed).toEqual([
        start + 100,
        start + 200,
        start + 300,
        start + 400,
        start + 500,
      ]);
    });

    it("computeMissedOccurrences works for cron across a window", () => {
      const from = new Date("2024-01-15T10:00:00Z").getTime();
      const to = new Date("2024-01-15T13:30:00Z").getTime();
      const missed = computeMissedOccurrences(
        { cron: "0 * * * *", timezone: "UTC" },
        from,
        to
      );
      // 11:00, 12:00, 13:00 UTC
      expect(missed).toHaveLength(3);
      expect(new Date(missed[0]).getUTCHours()).toBe(11);
      expect(new Date(missed[2]).getUTCHours()).toBe(13);
    });

    it("honors a timezone so DST shifts are respected", () => {
      const from = new Date("2024-01-15T00:00:00Z").getTime();
      const to = new Date("2024-01-16T12:00:00Z").getTime();
      const utc = computeMissedOccurrences(
        { cron: "0 12 * * *", timezone: "UTC" },
        from,
        to
      );
      const ny = computeMissedOccurrences(
        { cron: "0 12 * * *", timezone: "America/New_York" },
        from,
        to
      );
      expect(utc[0]).not.toBe(ny[0]);
    });

    it("catchup 'skip' fires exactly once for a missed schedule (default)", async () => {
      const enq: string[] = [];
      await manager.create(
        { name: "skip-task" } as never,
        {},
        { interval: 50 }
      );
      // simulate a long downtime
      await sleep(260);

      await manager.tick(async (name) => {
        enq.push(name);
        return "id";
      });

      expect(enq).toHaveLength(1);
    });

    it("catchup 'last' coalesces missed runs into a single execution", async () => {
      const enq: string[] = [];
      await manager.create(
        { name: "last-task" } as never,
        {},
        { interval: 50, catchup: "last" }
      );
      await sleep(260);

      await manager.tick(async (name) => {
        enq.push(name);
        return "id";
      });

      expect(enq).toHaveLength(1);
    });

    it("catchup 'all' re-runs every missed occurrence", async () => {
      const enq: string[] = [];
      const id = await manager.create(
        { name: "all-task" } as never,
        {},
        { interval: 50, catchup: "all" }
      );
      const created = await manager.get(id);
      expect(created?.catchup).toBe("all");

      // Force lastRunAt well in the past so several intervals are "missed"
      await kv.hmset(`covara:tasks:recurring:data:${id}`, {
        lastRunAt: String(Date.now() - 250),
        nextRunAt: String(Date.now() - 200),
      } as never);
      await kv.zadd("covara:tasks:recurring", Date.now() - 200, id);

      await manager.tick(async (name) => {
        enq.push(name);
        return "id";
      });

      // ~5 missed 50ms intervals over 250ms
      expect(enq.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Task progress + heartbeat + result TTL", () => {
    let kv: KVAdapter;
    let scheduler: TaskScheduler;
    let registry: TaskRegistry;
    let storage: TaskStorage;
    let workers: TaskWorker[];

    beforeAll(async () => {
      kv = createMemoryKV("test-ext-worker");
      await kv.connect();
    });
    afterAll(async () => {
      await kv.disconnect();
    });
    beforeEach(async () => {
      workers = [];
      await clearKv(kv);
      registry = createTaskRegistry();
      scheduler = createTaskScheduler(kv, registry);
      storage = createTaskStorage(kv);
    });

    const stopAll = async () => {
      for (const w of workers) await w.stop();
    };

    it("reportProgress persists progress that a monitor can read", async () => {
      let observedTaskId = "";
      const task = defineTask({
        name: "progress-task",
        handler: async (ctx) => {
          observedTaskId = ctx.taskId;
          await ctx.reportProgress(25, "starting");
          await sleep(40);
          await ctx.reportProgress(75, "almost");
          await sleep(40);
          return { ok: true };
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      await scheduler.enqueue(task, {});
      await sleep(60);

      const mid = await storage.getProgress(observedTaskId);
      expect(mid?.percent).toBeGreaterThanOrEqual(25);
      expect(mid?.message).toBeDefined();

      await sleep(120);
      const done = await storage.getProgress(observedTaskId);
      expect(done?.percent).toBe(75);

      await stopAll();
    });

    it("updates lastHeartbeatAt for long-running tasks", async () => {
      const task = defineTask({
        name: "heartbeat-task",
        handler: async () => {
          await sleep(120);
          return {};
        },
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, {
        pollIntervalMs: 20,
        heartbeatMs: 30,
      });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(80);

      const running = await storage.get(taskId);
      expect(running?.lastHeartbeatAt).toBeDefined();
      expect(running?.lastHeartbeatAt).toBeGreaterThan(running!.startedAt! - 1);

      await sleep(120);
      await stopAll();
    });

    it("sets resultExpiresAt and expires completed records via result TTL", async () => {
      const task = defineTask({
        name: "ttl-task",
        resultTtlMs: 250,
        handler: async () => ({ value: 1 }),
      });
      registry.register(task);

      const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
      workers.push(worker);
      await worker.start();

      const taskId = await scheduler.enqueue(task, {});
      await sleep(80);

      const completed = await storage.get(taskId);
      expect(completed?.status).toBe("completed");
      expect(completed?.resultExpiresAt).toBeDefined();

      // wait past the TTL; next read should expire and remove the record
      await sleep(250);
      const expired = await storage.get(taskId);
      expect(expired).toBeNull();

      await stopAll();
    });
  });

  describe("Cloudflare Queues adapter", () => {
    let kv: KVAdapter;
    let registry: TaskRegistry;
    let storage: TaskStorage;

    beforeAll(async () => {
      kv = createMemoryKV("test-ext-cfq");
      await kv.connect();
    });
    afterAll(async () => {
      await kv.disconnect();
    });
    beforeEach(async () => {
      await clearKv(kv);
      registry = createTaskRegistry();
      storage = createTaskStorage(kv);
    });

    it("producer sends a serializable message and returns a task id", async () => {
      const sent: { message: QueueTaskMessage; options?: unknown }[] = [];
      const binding: QueueBindingLike<QueueTaskMessage> = {
        async send(message, options) {
          sent.push({ message, options });
        },
      };
      const task = defineTask({
        name: "cf-produce",
        handler: async () => ({}),
      });

      const producer = createCloudflareQueueProducer(binding);
      const id = await producer.enqueue(task, { hello: "world" });

      expect(sent).toHaveLength(1);
      expect(sent[0].message.taskId).toBe(id);
      expect(sent[0].message.name).toBe("cf-produce");
      expect(sent[0].message.input).toEqual({ hello: "world" });
    });

    it("consumer executes a task from a fake MessageBatch and acks", async () => {
      let ran = false;
      let receivedInput: unknown;
      const task = defineTask({
        name: "cf-consume",
        handler: async (ctx, input) => {
          ran = true;
          receivedInput = input;
          await ctx.reportProgress(50);
          return { processed: true };
        },
      });
      registry.register(task);

      const consumer = createQueueConsumer({ kv, registry });

      const message = makeFakeMessage<QueueTaskMessage>({
        taskId: "cf-task-1",
        name: "cf-consume",
        input: { a: 1 },
        attempt: 0,
        maxAttempts: 3,
        priority: 50,
        scheduledFor: Date.now(),
        createdAt: Date.now(),
      });

      await consumer.process(makeBatch([message]));

      expect(ran).toBe(true);
      expect(receivedInput).toEqual({ a: 1 });
      expect(message.acked).toBe(true);
      expect(message.retried).toBe(false);

      const stored = await storage.get("cf-task-1");
      expect(stored?.status).toBe("completed");
      expect(stored?.result).toEqual({ processed: true });
    });

    it("consumer retries the message on handler failure (within attempts)", async () => {
      const task = defineTask({
        name: "cf-retry",
        retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 1000 },
        handler: async () => {
          throw new Error("kaboom");
        },
      });
      registry.register(task);

      const consumer = createQueueConsumer({ kv, registry });

      const message = makeFakeMessage<QueueTaskMessage>(
        {
          taskId: "cf-retry-1",
          name: "cf-retry",
          input: {},
          attempt: 0,
          maxAttempts: 3,
          priority: 50,
          scheduledFor: Date.now(),
          createdAt: Date.now(),
        },
        1
      );

      await consumer.process(makeBatch([message]));

      expect(message.retried).toBe(true);
      expect(message.acked).toBe(false);
      expect(message.retryDelay).toBeGreaterThanOrEqual(1);

      const stored = await storage.get("cf-retry-1");
      expect(stored?.status).toBe("scheduled");
      expect(stored?.lastError).toBe("kaboom");
    });

    it("consumer dead-letters and acks when attempts are exhausted", async () => {
      const alerts: DeadLetterEntry[] = [];
      const task = defineTask({
        name: "cf-dead",
        retry: { maxAttempts: 2 },
        handler: async () => {
          throw new Error("fatal");
        },
      });
      registry.register(task);

      const consumer = createQueueConsumer({
        kv,
        registry,
        onDlqEnqueue: (entry) => void alerts.push(entry),
      });

      const message = makeFakeMessage<QueueTaskMessage>(
        {
          taskId: "cf-dead-1",
          name: "cf-dead",
          input: {},
          attempt: 1,
          maxAttempts: 2,
          priority: 50,
          scheduledFor: Date.now(),
          createdAt: Date.now(),
        },
        2
      );

      await consumer.process(makeBatch([message]));

      expect(message.acked).toBe(true);
      expect(message.retried).toBe(false);
      expect(alerts).toHaveLength(1);

      const stored = await storage.get("cf-dead-1");
      expect(stored?.status).toBe("dead");
    });
  });
});
