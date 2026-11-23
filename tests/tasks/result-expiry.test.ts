import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStorage } from "@/tasks/storage";
import { createTaskRegistry } from "@/tasks/scheduler";
import { createTaskScheduler } from "@/tasks/scheduler";
import { createTaskWorker } from "@/tasks/worker";
import { defineTask } from "@/tasks/define";
import { createMemoryKV, type KVAdapter } from "@/kv";
import type { Task } from "@/tasks/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (overrides: Partial<Task>): Task => ({
  id: crypto.randomUUID(),
  name: "expiring",
  input: {},
  status: "running",
  priority: 50,
  createdAt: Date.now(),
  scheduledFor: Date.now(),
  attempt: 0,
  maxAttempts: 1,
  ...overrides,
});

describe("finished task results expire without being read", () => {
  let kv: KVAdapter;

  beforeEach(async () => {
    kv = createMemoryKV(`result-expiry-${crypto.randomUUID()}`);
    await kv.connect();
  });
  afterEach(() => kv.disconnect());

  it("a completed task's record carries a TTL ending at resultExpiresAt", async () => {
    const storage = createTaskStorage(kv);
    const t = task({});
    await storage.store(t);
    await storage.updateStatus(t.id, "running", "completed", { result: 1, resultExpiresAt: Date.now() + 5_000 });
    const ttl = await kv.ttl(`covara:tasks:data:${t.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it("a record without resultExpiresAt keeps no TTL", async () => {
    const storage = createTaskStorage(kv);
    const t = task({});
    await storage.store(t);
    await storage.updateStatus(t.id, "running", "scheduled", { attempt: 1 });
    expect(await kv.ttl(`covara:tasks:data:${t.id}`)).toBe(-1);
  });

  it("expired tasks leave the status and name indexes on the next completion", async () => {
    const storage = createTaskStorage(kv);
    const old = task({ name: "old-kind" });
    await storage.store(old);
    await storage.updateStatus(old.id, "running", "completed", { result: 1, resultExpiresAt: Date.now() + 200 });
    await sleep(1_300);
    expect(await kv.exists(`covara:tasks:data:${old.id}`)).toBe(0);

    const next = task({});
    await storage.store(next);
    await storage.updateStatus(next.id, "running", "completed", { result: 2, resultExpiresAt: Date.now() + 60_000 });

    expect(await kv.sismember("covara:tasks:status:completed", old.id)).toBe(false);
    expect(await kv.sismember("covara:tasks:name:old-kind", old.id)).toBe(false);
    expect(await kv.sismember("covara:tasks:status:completed", next.id)).toBe(true);
  });

  it("an older index entry never removes a task whose expiry moved later", async () => {
    const storage = createTaskStorage(kv);
    const t = task({});
    await storage.store(t);
    await storage.updateStatus(t.id, "running", "completed", { result: 1, resultExpiresAt: Date.now() + 100 });
    await storage.updateStatus(t.id, "completed", "completed", { resultExpiresAt: Date.now() + 60_000 });
    await sleep(150);
    const other = task({});
    await storage.store(other);
    await storage.updateStatus(other.id, "running", "completed", { result: 2, resultExpiresAt: Date.now() + 60_000 });
    expect(await kv.exists(`covara:tasks:data:${t.id}`)).toBe(1);
    expect(await kv.sismember("covara:tasks:status:completed", t.id)).toBe(true);
  });

  it("a worker-completed task with resultTtlMs is gone after expiry, worker stopped", async () => {
    const registry = createTaskRegistry();
    const done = defineTask({ name: "expiry.done", handler: async () => ({ ok: true }), resultTtlMs: 300 });
    registry.register(done);
    const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
    await worker.start();
    const id = await createTaskScheduler(kv, registry).enqueue(done, {});
    for (let i = 0; i < 100 && (await kv.hget(`covara:tasks:data:${id}`, "status")) !== "completed"; i++) await sleep(20);
    await worker.stop();
    expect(await kv.hget(`covara:tasks:data:${id}`, "status")).toBe("completed");
    await sleep(1_500);
    expect(await kv.exists(`covara:tasks:data:${id}`)).toBe(0);
  });
});
