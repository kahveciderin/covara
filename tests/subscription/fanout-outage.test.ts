import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  registerHandler,
  unregisterHandler,
  clearAllSubscriptions,
} from "@/resource/subscription";
import { createMemoryKV, setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

const writer = (): SSEWriter & { frames: string[] } => {
  const frames: string[] = [];
  return {
    frames,
    write: (chunk: string) => (frames.push(chunk), true),
    close: () => {},
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    onClose: () => {},
  };
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("cross-process fan-out while the KV is unreachable", () => {
  let kv: KVAdapter;
  let down: boolean;
  let subscribeCalls: number;
  let unhandled: unknown[];
  let logs: LogRecord[];
  let previousLogger: ReturnType<typeof getLogger>;
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const memory = createMemoryKV(`fanout-${crypto.randomUUID()}`);
    await memory.connect();
    down = false;
    subscribeCalls = 0;
    kv = new Proxy(memory, {
      get(target, prop) {
        if (prop === "subscribeScoped") return undefined;
        if (prop === "subscribe") {
          return async (...args: Parameters<KVAdapter["subscribe"]>) => {
            subscribeCalls++;
            if (down) throw new Error("Connection is closed.");
            return target.subscribe(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setGlobalKV(kv);
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    logs = [];
    previousLogger = getLogger();
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
  });

  afterEach(async () => {
    await clearAllSubscriptions();
    process.off("unhandledRejection", onUnhandled);
    setLogger(previousLogger);
    vi.useRealTimers();
    clearGlobalKV();
  });

  const unhandledAfterTick = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
    return unhandled;
  };

  it("the first handler's failed fan-out start is not an unhandled rejection", async () => {
    down = true;
    registerHandler("h1", writer());
    await settle();
    expect(await unhandledAfterTick()).toEqual([]);
    expect(subscribeCalls).toBe(1);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("retries while handlers are open and logs once per outage", async () => {
    down = true;
    registerHandler("h1", writer());
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(subscribeCalls).toBeGreaterThan(3);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(await unhandledAfterTick()).toEqual([]);
  });

  it("once the KV is back the fan-out subscribes and local subscribers are told to refetch", async () => {
    down = true;
    const w = writer();
    registerHandler("h1", w);
    down = false;
    await createSubscription({ resource: "items", filter: "", authId: null, handlerId: "h1" });
    down = true;
    await settle();
    w.frames.length = 0;
    down = false;
    const before = subscribeCalls;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscribeCalls).toBeGreaterThan(before);
    const calls = subscribeCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribeCalls).toBe(calls);
    expect(w.frames.join("")).toContain("invalidate");
    expect(logs.some((l) => l.level === "info" && /fan-out/i.test(l.msg))).toBe(true);
  });

  it("stops retrying once the last handler closes", async () => {
    down = true;
    registerHandler("h1", writer());
    await settle();
    await unregisterHandler("h1");
    const calls = subscribeCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscribeCalls).toBe(calls);
  });

  it("a later outage is logged again", async () => {
    down = true;
    registerHandler("h1", writer());
    await settle();
    down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await unregisterHandler("h1");
    down = true;
    registerHandler("h2", writer());
    await settle();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
    expect(await unhandledAfterTick()).toEqual([]);
  });
});
