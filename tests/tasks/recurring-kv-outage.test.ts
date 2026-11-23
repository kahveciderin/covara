import { describe, it, expect, afterEach } from "vitest";
import { createMemoryKV, type KVAdapter } from "@/kv";
import { startRecurringScheduler, createRecurringManager } from "@/tasks/recurring";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

const previousLogger = getLogger();
afterEach(() => setLogger(previousLogger));

describe("startRecurringScheduler with an unreachable KV", () => {
  it("logs failed ticks instead of rejecting unhandled, and never overlaps ticks", async () => {
    const logs: LogRecord[] = [];
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    const memory = createMemoryKV("recurring-outage");
    await memory.connect();
    let down = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const kv = new Proxy(memory, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (!down) return value.apply(target, args);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 60));
          inFlight--;
          throw new Error("KV unreachable");
        };
      },
    }) as KVAdapter;
    await createRecurringManager(kv).create({ name: "job" } as any, {}, { interval: 10 });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    down = true;
    const stop = startRecurringScheduler(kv, async () => "id", 10);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    await new Promise((r) => setTimeout(r, 100));
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
    expect(maxInFlight).toBe(1);
    expect(logs.some((l) => l.level === "error" && /recurring/i.test(l.msg))).toBe(true);
    await memory.disconnect();
  });
});
