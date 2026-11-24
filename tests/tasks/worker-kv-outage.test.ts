import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryKV, type KVAdapter } from "@/kv";
import { createTaskRegistry, createTaskScheduler, createTaskWorker, defineTask } from "@/tasks";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

describe("an idle task worker while the KV is unreachable", () => {
  let memory: KVAdapter;
  let kv: KVAdapter;
  let down: boolean;
  let failedCalls: number;
  let logs: LogRecord[];
  let consoleError: ReturnType<typeof vi.spyOn>;
  const previousLogger = getLogger();

  beforeEach(async () => {
    memory = createMemoryKV(`worker-outage-${crypto.randomUUID()}`);
    await memory.connect();
    down = false;
    failedCalls = 0;
    kv = new Proxy(memory, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (down && prop !== "multi") {
            failedCalls++;
            return Promise.reject(new Error("Connection is closed."));
          }
          return value.apply(target, args);
        };
      },
    }) as KVAdapter;
    logs = [];
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    setLogger(previousLogger);
    consoleError.mockRestore();
    vi.useRealTimers();
    await memory.disconnect();
  });

  const registry = () => {
    const r = createTaskRegistry();
    r.register(defineTask({ name: "outage.job", handler: async () => ({ ok: true }) }));
    return r;
  };

  it("logs one line for the outage, backs off, and says when polling works again", async () => {
    const reg = registry();
    const worker = createTaskWorker(kv, reg, { pollIntervalMs: 10 });
    await worker.start();
    down = true;
    await new Promise((r) => setTimeout(r, 400));
    const polls = failedCalls;
    expect(polls).toBeLessThan(12);
    expect(consoleError.mock.calls.filter((c) => /poll failed/.test(String(c[0])))).toHaveLength(0);
    expect(logs.filter((l) => l.level === "warn" && /poll/i.test(l.msg))).toHaveLength(1);

    down = false;
    const id = await createTaskScheduler(kv, reg).enqueue(defineTask({ name: "outage.job", handler: async () => ({}) }), {});
    for (let i = 0; i < 100 && (await kv.hget(`covara:tasks:data:${id}`, "status")) !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await kv.hget(`covara:tasks:data:${id}`, "status")).toBe("completed");
    expect(logs.some((l) => l.level === "info" && /poll/i.test(l.msg))).toBe(true);
    await worker.stop();
  });

  it("stop() during a backoff leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const worker = createTaskWorker(kv, registry(), { pollIntervalMs: 1000 });
    await worker.start();
    down = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await worker.stop().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the reclaim loop logs an outage once, backs off, and says when it works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const worker = createTaskWorker(kv, registry(), { pollIntervalMs: 1000, lockTtlMs: 3000 });
    await worker.start();
    await vi.advanceTimersByTimeAsync(10);
    down = true;
    const callsBefore = failedCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consoleError.mock.calls.filter((c) => /reclaim/.test(String(c[0])))).toHaveLength(0);
    expect(logs.filter((l) => l.level === "warn" && /reclaim/i.test(l.msg))).toHaveLength(1);
    const reclaimCalls = failedCalls - callsBefore;
    expect(reclaimCalls).toBeLessThan(60);

    down = false;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(logs.some((l) => l.level === "info" && /reclaim/i.test(l.msg))).toBe(true);
    await worker.stop();
  });
});
