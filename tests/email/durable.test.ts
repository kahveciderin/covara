import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDurableEmailAdapter, durableEmail } from "@/email/durable";
import type { EmailDeliveryFailure, EmailTaskInput } from "@/email/durable";
import { EmailDeliveryError } from "@/email/errors";
import { createResendAdapter } from "@/email/resend";
import type { EmailAdapter, EmailMessage, SendEmailOptions } from "@/email/types";
import { createMemoryKV, KVAdapter, setGlobalKV, clearGlobalKV } from "@/kv";
import { createTaskScheduler, createTaskRegistry, TaskRegistry, TaskScheduler } from "@/tasks/scheduler";
import { createTaskWorker, TaskWorker } from "@/tasks/worker";
import { createDeadLetterQueue } from "@/tasks/dlq";
import { createTaskStorage } from "@/tasks/storage";
import {
  createCloudflareQueueProducer,
  createQueueConsumer,
  QueueMessageLike,
  QueueTaskMessage,
} from "@/tasks/cloudflare-queues";
import type { DeadLetterEntry } from "@/tasks/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
};

const message: EmailMessage = {
  from: "noreply@acme.com",
  to: "user@example.com",
  subject: "Hello",
  text: "Hi",
};

interface ScriptedAdapter extends EmailAdapter {
  calls: { message: EmailMessage; options?: SendEmailOptions }[];
}

const scripted = (outcomes: (Error | string)[], provider = "fake"): ScriptedAdapter => {
  const calls: ScriptedAdapter["calls"] = [];
  let index = 0;
  return {
    provider,
    calls,
    async send(m, options) {
      calls.push({ message: m, options });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index++;
      if (outcome instanceof Error) throw outcome;
      return { id: outcome, provider };
    },
  };
};

const transient = (retryAfterMs?: number) =>
  new EmailDeliveryError("provider unavailable", { provider: "fake", status: 503, retryAfterMs });

const permanent = () =>
  new EmailDeliveryError("invalid recipient", { provider: "fake", status: 422, permanent: true });

describe("durableEmail: queued mode (KV task worker)", () => {
  let kv: KVAdapter;
  let scheduler: TaskScheduler;
  let registry: TaskRegistry;
  let worker: TaskWorker | null;

  beforeEach(async () => {
    kv = createMemoryKV(`durable-email-${Math.random()}`);
    await kv.connect();
    registry = createTaskRegistry();
    scheduler = createTaskScheduler(kv, registry);
    worker = null;
  });

  afterEach(async () => {
    if (worker) await worker.stop();
    await kv.disconnect();
  });

  const startWorker = async (onDlqEnqueue?: (entry: DeadLetterEntry) => void) => {
    worker = createTaskWorker(kv, registry, { pollIntervalMs: 10, heartbeatMs: 1000, onDlqEnqueue });
    await worker.start();
  };

  it("returns quickly with a queued result and does not call the provider inline", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    const result = await durable.send(message);

    expect(result.status).toBe("queued");
    expect(result.provider).toBe("fake");
    expect(typeof result.id).toBe("string");
    expect(typeof result.taskId).toBe("string");
    expect(inner.calls).toHaveLength(0);
    expect(durable.durable).toBe(true);
    expect(await scheduler.getQueueDepth()).toBe(1);
  });

  it("delivers through the worker and passes the idempotency key to the provider", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    registry.register(durable.task);

    const result = await durable.send(message, { idempotencyKey: "welcome:u1" });
    expect(result.id).toBe("welcome:u1");
    await startWorker();

    await waitFor(() => inner.calls.length === 1);
    expect(inner.calls[0].options?.idempotencyKey).toBe("welcome:u1");
    expect(inner.calls[0].message).toEqual(message);
    await waitFor(async () => (await scheduler.getTask(result.taskId!))?.status === "completed");
  });

  it("retries transient failures and eventually succeeds", async () => {
    const inner = scripted([transient(), transient(), "p1"]);
    const durable = createDurableEmailAdapter(inner, {
      queue: scheduler,
      kv,
      retry: { maxAttempts: 5, initialDelayMs: 5, maxDelayMs: 20 },
    });
    registry.register(durable.task);

    const { taskId } = await durable.send(message);
    await startWorker();

    await waitFor(async () => (await scheduler.getTask(taskId!))?.status === "completed");
    expect(inner.calls).toHaveLength(3);
  });

  it("sends permanent failures straight to the DLQ without retrying", async () => {
    const inner = scripted([permanent()]);
    const failures: EmailDeliveryFailure[] = [];
    const dlqEntries: DeadLetterEntry[] = [];
    const durable = createDurableEmailAdapter(inner, {
      queue: scheduler,
      kv,
      retry: { maxAttempts: 5, initialDelayMs: 5 },
      onDeliveryFailed: (f) => {
        failures.push(f);
      },
    });
    registry.register(durable.task);

    const { taskId, id } = await durable.send(message);
    await startWorker((entry) => dlqEntries.push(entry));

    await waitFor(() => dlqEntries.length === 1);
    expect(inner.calls).toHaveLength(1);
    expect(dlqEntries[0].taskId).toBe(taskId);
    expect(dlqEntries[0].reason).toMatch(/invalid recipient/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      messageId: id,
      provider: "fake",
      permanent: true,
      attempts: 1,
      mode: "queued",
      taskId,
    });
    expect(failures[0].message.to).toBe("user@example.com");
  });

  it("lands in the DLQ after max attempts and fires onDeliveryFailed exactly once", async () => {
    const inner = scripted([transient()]);
    const failures: EmailDeliveryFailure[] = [];
    const durable = createDurableEmailAdapter(inner, {
      queue: scheduler,
      kv,
      retry: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 10 },
      onDeliveryFailed: (f) => {
        failures.push(f);
      },
    });
    registry.register(durable.task);

    const { taskId } = await durable.send(message);
    await startWorker();

    const dlq = createDeadLetterQueue(kv, async () => "");
    await waitFor(async () => (await dlq.count()) === 1);
    expect(inner.calls).toHaveLength(3);
    expect((await dlq.get(taskId!))?.reason).toMatch(/provider unavailable/);
    await sleep(30);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ permanent: false, attempts: 3 });
  });

  it("swallows errors thrown by onDeliveryFailed", async () => {
    const inner = scripted([permanent()]);
    const durable = createDurableEmailAdapter(inner, {
      queue: scheduler,
      kv,
      onDeliveryFailed: () => {
        throw new Error("hook broke");
      },
    });
    registry.register(durable.task);
    const { taskId } = await durable.send(message);
    await startWorker();
    await waitFor(async () => (await scheduler.getTask(taskId!))?.status === "dead");
    expect((await scheduler.getTask(taskId!))?.lastError).toMatch(/invalid recipient/);
  });

  it("schedules the retry using the provider's Retry-After", async () => {
    const inner = scripted([transient(4000), "p1"]);
    const durable = createDurableEmailAdapter(inner, {
      queue: scheduler,
      kv,
      retry: { maxAttempts: 3, initialDelayMs: 5 },
    });
    registry.register(durable.task);

    const { taskId } = await durable.send(message);
    const before = Date.now();
    await startWorker();

    await waitFor(async () => (await scheduler.getTask(taskId!))?.status === "scheduled");
    const task = await scheduler.getTask(taskId!);
    expect(task!.scheduledFor - before).toBeGreaterThanOrEqual(3900);
    expect(task!.scheduledFor - before).toBeLessThan(6000);
  });

  it("caps Retry-After at maxRetryAfterMs", () => {
    const durable = createDurableEmailAdapter(scripted(["x"]), {
      queue: scheduler,
      retry: { maxRetryAfterMs: 1000 },
    });
    const delay = durable.task.retry!.retryDelayMs!(transient(60_000), 1);
    expect(delay).toBe(1000);
    expect(durable.task.retry!.retryDelayMs!(transient(), 1)).toBeUndefined();
    expect(durable.task.retry!.retryOn!(permanent())).toBe(false);
    expect(durable.task.retry!.retryOn!(new Error("socket hang up"))).toBe(true);
  });

  it("dedupes a duplicate enqueue with the same idempotency key", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    registry.register(durable.task);

    const first = await durable.send(message, { idempotencyKey: "dup" });
    const second = await durable.send(message, { idempotencyKey: "dup" });
    expect(second.taskId).toBe(first.taskId);

    await startWorker();
    await waitFor(async () => (await scheduler.getTask(first.taskId!))?.status === "completed");

    const third = await durable.send(message, { idempotencyKey: "dup" });
    await waitFor(async () => (await scheduler.getTask(third.taskId!))?.status === "completed");
    expect(inner.calls).toHaveLength(1);
  });

  it("does not re-send when the task re-runs after the provider accepted (crash before ack)", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    const input: EmailTaskInput = {
      messageId: "m1",
      idempotencyKey: "m1",
      provider: "fake",
      message,
      enqueuedAt: Date.now(),
    };
    const ctx = {
      taskId: "t1",
      attempt: 1,
      workerId: "w",
      signal: new AbortController().signal,
      scheduledAt: new Date(),
      startedAt: new Date(),
      db: undefined,
      reportProgress: async () => {},
    };

    const first = await durable.task.handler(ctx, input);
    const second = await durable.task.handler({ ...ctx, attempt: 2 }, input);
    expect(inner.calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ id: "p1", provider: "fake", status: "sent" });
  });

  it("forwards the same Idempotency-Key to Resend on every retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const durable = createDurableEmailAdapter(createResendAdapter({ apiKey: "k" }), {
        queue: scheduler,
        kv,
        retry: { initialDelayMs: 5, maxDelayMs: 10 },
      });
      registry.register(durable.task);
      const { taskId } = await durable.send(message, { idempotencyKey: "reset:abc" });
      await startWorker();
      await waitFor(async () => (await scheduler.getTask(taskId!))?.status === "completed");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("reset:abc");
      expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).toBe("reset:abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects oversized payloads before enqueueing", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv, maxPayloadBytes: 1024 });
    const error = await durable
      .send({
        ...message,
        attachments: [{ filename: "big.bin", content: new Uint8Array(4096) }],
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.permanent).toBe(true);
    expect(error.code).toBe("payload_too_large");
    expect(await scheduler.getQueueDepth()).toBe(0);
  });

  it("round-trips binary attachments through the stored task", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    registry.register(durable.task);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await durable.send({
      ...message,
      attachments: [
        { filename: "a.bin", content: bytes, contentType: "application/octet-stream" },
        { filename: "b.txt", content: "SGVsbG8=" },
      ],
    });
    await startWorker();
    await waitFor(() => inner.calls.length === 1);
    const [a, b] = inner.calls[0].message.attachments!;
    expect(a.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(a.content as Uint8Array)).toEqual([0, 1, 2, 250, 255]);
    expect(a.contentType).toBe("application/octet-stream");
    expect(b.content).toBe("SGVsbG8=");
  });

  it("sendBatch enqueues one task per message with derived keys", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
    const results = await durable.sendBatch!([message, message], { idempotencyKey: "b" });
    expect(results.map((r) => r.id)).toEqual(["b:0", "b:1"]);
    expect(await scheduler.getQueueDepth()).toBe(2);
  });

  it("uses the global KV for dedupe markers when none is passed", async () => {
    setGlobalKV(kv);
    try {
      const inner = scripted(["p1"]);
      const durable = createDurableEmailAdapter(inner, { queue: scheduler });
      const input: EmailTaskInput = {
        messageId: "g1",
        idempotencyKey: "g1",
        provider: "fake",
        message,
        enqueuedAt: Date.now(),
      };
      const ctx = {
        taskId: "t",
        attempt: 1,
        workerId: "w",
        signal: new AbortController().signal,
        scheduledAt: new Date(),
        startedAt: new Date(),
        db: undefined,
        reportProgress: async () => {},
      };
      await durable.task.handler(ctx, input);
      await durable.task.handler(ctx, input);
      expect(inner.calls).toHaveLength(1);
    } finally {
      clearGlobalKV();
    }
  });
});

describe("durableEmail: Cloudflare Queues", () => {
  let kv: KVAdapter;

  beforeEach(async () => {
    kv = createMemoryKV(`durable-email-cf-${Math.random()}`);
    await kv.connect();
  });

  afterEach(async () => {
    await kv.disconnect();
  });

  const makeMessage = (
    body: QueueTaskMessage,
    attempts: number
  ): QueueMessageLike<QueueTaskMessage> & { acked: boolean; retried?: { delaySeconds?: number } } => {
    const m = {
      id: "qm",
      timestamp: new Date(),
      body,
      attempts,
      acked: false,
      retried: undefined as { delaySeconds?: number } | undefined,
      ack() {
        m.acked = true;
      },
      retry(options?: { delaySeconds?: number }) {
        m.retried = options ?? {};
      },
    };
    return m;
  };

  it("produces a JSON-serializable message and delivers binary attachments intact", async () => {
    const sent: QueueTaskMessage[] = [];
    const producer = createCloudflareQueueProducer({
      send: async (body) => {
        sent.push(JSON.parse(JSON.stringify(body)));
      },
    });
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: producer, kv });
    const registry = createTaskRegistry();
    registry.register(durable.task);

    await durable.send({
      ...message,
      attachments: [{ filename: "x.bin", content: new Uint8Array([9, 8, 7]) }],
    });
    expect(sent).toHaveLength(1);

    const consumer = createQueueConsumer({ kv, registry });
    const qm = makeMessage(sent[0], 1);
    await consumer.process({ queue: "email", messages: [qm] });
    expect(qm.acked).toBe(true);
    expect(Array.from(inner.calls[0].message.attachments![0].content as Uint8Array)).toEqual([9, 8, 7]);
  });

  it("retries with the provider's Retry-After as delaySeconds", async () => {
    const sent: QueueTaskMessage[] = [];
    const producer = createCloudflareQueueProducer({ send: async (b) => void sent.push(b) });
    const inner = scripted([transient(9000)]);
    const durable = createDurableEmailAdapter(inner, { queue: producer, kv });
    const registry = createTaskRegistry();
    registry.register(durable.task);

    await durable.send(message);
    const consumer = createQueueConsumer({ kv, registry });
    const qm = makeMessage(sent[0], 1);
    await consumer.process({ queue: "email", messages: [qm] });
    expect(qm.acked).toBe(false);
    expect(qm.retried?.delaySeconds).toBe(9);
  });

  it("dead-letters permanent failures and fires the hook", async () => {
    const sent: QueueTaskMessage[] = [];
    const producer = createCloudflareQueueProducer({ send: async (b) => void sent.push(b) });
    const failures: EmailDeliveryFailure[] = [];
    const durable = createDurableEmailAdapter(scripted([permanent()]), {
      queue: producer,
      kv,
      onDeliveryFailed: (f) => void failures.push(f),
    });
    const registry = createTaskRegistry();
    registry.register(durable.task);

    await durable.send(message);
    const consumer = createQueueConsumer({ kv, registry });
    const qm = makeMessage(sent[0], 1);
    await consumer.process({ queue: "email", messages: [qm] });
    expect(qm.acked).toBe(true);
    expect(qm.retried).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(await createTaskStorage(kv).get(sent[0].taskId)).toMatchObject({ status: "dead" });
  });

  it("works without any KV (no dedupe markers)", async () => {
    clearGlobalKV();
    const sent: QueueTaskMessage[] = [];
    const producer = createCloudflareQueueProducer({ send: async (b) => void sent.push(b) });
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { queue: producer });
    const result = await durable.send(message);
    expect(result.status).toBe("queued");
    expect(sent).toHaveLength(1);
  });
});

describe("durableEmail: inline fallback (no queue)", () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warn = vi.fn();
    clearGlobalKV();
  });

  it("sends inline and reports status sent", async () => {
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { logger: { warn } });
    const result = await durable.send(message);
    expect(result).toMatchObject({ id: "p1", provider: "fake", status: "sent" });
    expect(durable.durable).toBe(false);
  });

  it("warns exactly once that delivery is not durable", async () => {
    const durable = createDurableEmailAdapter(scripted(["p1"]), { logger: { warn } });
    await durable.send(message);
    await durable.send(message);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not durable/i);
  });

  it("retries transient failures within the bounded budget", async () => {
    const inner = scripted([transient(), "p1"]);
    const durable = createDurableEmailAdapter(inner, {
      logger: { warn },
      inline: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    });
    const result = await durable.send(message);
    expect(result.id).toBe("p1");
    expect(inner.calls).toHaveLength(2);
  });

  it("does not retry permanent failures and throws the typed error", async () => {
    const inner = scripted([permanent()]);
    const failures: EmailDeliveryFailure[] = [];
    const durable = createDurableEmailAdapter(inner, {
      logger: { warn },
      onDeliveryFailed: (f) => void failures.push(f),
    });
    const error = await durable.send(message).catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.permanent).toBe(true);
    expect(inner.calls).toHaveLength(1);
    expect(failures).toMatchObject([{ mode: "inline", attempts: 1, permanent: true }]);
  });

  it("gives up after maxAttempts and reports the failure", async () => {
    const inner = scripted([transient()]);
    const failures: EmailDeliveryFailure[] = [];
    const durable = createDurableEmailAdapter(inner, {
      logger: { warn },
      inline: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
      onDeliveryFailed: (f) => void failures.push(f),
    });
    await expect(durable.send(message)).rejects.toThrow(/provider unavailable/);
    expect(inner.calls).toHaveLength(3);
    expect(failures).toMatchObject([{ mode: "inline", attempts: 3, permanent: false }]);
  });

  it("honours a short Retry-After and gives up on one beyond the inline cap", async () => {
    const shortInner = scripted([transient(20), "p1"]);
    const durable = createDurableEmailAdapter(shortInner, {
      logger: { warn },
      inline: { initialDelayMs: 1, maxRetryAfterMs: 100 },
    });
    const started = Date.now();
    await durable.send(message);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(shortInner.calls).toHaveLength(2);

    const longInner = scripted([transient(60_000), "p1"]);
    const capped = createDurableEmailAdapter(longInner, {
      logger: { warn },
      inline: { initialDelayMs: 1, maxRetryAfterMs: 100 },
    });
    await expect(capped.send(message)).rejects.toThrow(/provider unavailable/);
    expect(longInner.calls).toHaveLength(1);
  });

  it("wraps non-Error throws into an Error", async () => {
    const inner: EmailAdapter = {
      provider: "odd",
      send: async () => {
        throw "boom";
      },
    };
    const durable = createDurableEmailAdapter(inner, {
      logger: { warn },
      inline: { maxAttempts: 1 },
    });
    const error = await durable.send(message).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/boom/);
  });

  it("dedupes inline sends with the same idempotency key when KV is available", async () => {
    const kv = createMemoryKV(`inline-${Math.random()}`);
    await kv.connect();
    const inner = scripted(["p1"]);
    const durable = createDurableEmailAdapter(inner, { kv, logger: { warn } });
    const a = await durable.send(message, { idempotencyKey: "k" });
    const b = await durable.send(message, { idempotencyKey: "k" });
    expect(inner.calls).toHaveLength(1);
    expect(b).toEqual(a);
    await kv.disconnect();
  });

  it("is exported under the durableEmail alias", () => {
    expect(durableEmail).toBe(createDurableEmailAdapter);
  });
});
