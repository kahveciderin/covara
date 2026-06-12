import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  removeSubscription,
  getSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  updateSubscriptionSeq,
  getSubscriptionStats,
  getSubscriptionsForResource,
  getHandlerSubscriptions,
  listActiveSubscriptions,
  clearAllSubscriptions,
} from "@/resource/subscription";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

type SpyKV = KVAdapter & { hgetallKeys: string[] };

const wrapWithSpy = (kv: KVAdapter): SpyKV => {
  const hgetallKeys: string[] = [];
  const spy = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "hgetallKeys") return hgetallKeys;
      if (prop === "hgetall") {
        return async (key: string) => {
          hgetallKeys.push(key);
          return target.hgetall(key);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return spy as SpyKV;
};

const createMockWriter = (): SSEWriter & { getEvents: () => any[] } => {
  const chunks: string[] = [];
  const closeCallbacks: (() => void)[] = [];
  const writer = {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    close: vi.fn(() => {
      (writer as { closed: boolean }).closed = true;
      for (const cb of closeCallbacks.splice(0)) cb();
    }),
    onClose: (cb: () => void) => {
      closeCallbacks.push(cb);
    },
    getEvents: () =>
      chunks
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice(6).trim())),
  };
  return writer as unknown as SSEWriter & { getEvents: () => any[] };
};

const createMockFilter = () =>
  ({
    compile: (expr: string) => ({
      execute: (obj: Record<string, unknown>) => {
        if (!expr || expr === "*") return true;
        const match = expr.match(/userId=="([^"]+)"/);
        if (match) return obj.userId === match[1];
        return true;
      },
    }),
    convert: (expr: string) => expr,
    execute: () => true,
    clearCache: () => {},
  }) as any;

describe("Per-resource subscription sharding", () => {
  let kv: SpyKV;

  beforeAll(async () => {
    const memory = createMemoryKV("shard-test");
    await memory.connect();
    kv = wrapWithSpy(memory);
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    await clearAllSubscriptions();
    kv.hgetallKeys.length = 0;
  });

  const makeSub = async (resource: string, handlerId: string, filter = "") =>
    createSubscription({
      resource,
      filter,
      handlerId,
      authId: null,
    });

  it("a push to one resource never reads another resource's subscriptions", async () => {
    const writerA = createMockWriter();
    const writerB = createMockWriter();
    registerHandler("handler-a", writerA);
    registerHandler("handler-b", writerB);
    await makeSub("res_alpha", "handler-a");
    await makeSub("res_beta", "handler-b");

    kv.hgetallKeys.length = 0;
    await pushInsertsToSubscriptions(
      "res_alpha",
      createMockFilter(),
      [{ id: "1", userId: "u1" }],
      "id"
    );

    expect(kv.hgetallKeys.length).toBeGreaterThan(0);
    for (const key of kv.hgetallKeys) {
      expect(key).toContain("res_alpha");
      expect(key).not.toContain("res_beta");
    }

    expect(writerA.getEvents().some((e) => e.type === "added")).toBe(true);
    expect(writerB.getEvents().some((e) => e.type === "added")).toBe(false);

    await unregisterHandler("handler-a");
    await unregisterHandler("handler-b");
  });

  it("getSubscription / removeSubscription round-trip through the sharded layout", async () => {
    registerHandler("handler-rt", createMockWriter());
    const subId = await makeSub("res_round", "handler-rt", 'userId=="u9"');

    const sub = await getSubscription(subId);
    expect(sub).toBeDefined();
    expect(sub!.resource).toBe("res_round");
    expect(sub!.filter).toBe('userId=="u9"');

    await removeSubscription(subId);
    expect(await getSubscription(subId)).toBeUndefined();
    await unregisterHandler("handler-rt");
  });

  it("updateSubscriptionSeq persists through the sharded layout", async () => {
    registerHandler("handler-seq", createMockWriter());
    const subId = await makeSub("res_seq", "handler-seq");

    await updateSubscriptionSeq(subId, 42);
    const sub = await getSubscription(subId);
    expect(sub!.lastSeq).toBe(42);
    await unregisterHandler("handler-seq");
  });

  it("unregisterHandler removes only that handler's subscriptions without scanning KV", async () => {
    registerHandler("handler-x", createMockWriter());
    registerHandler("handler-y", createMockWriter());
    const subX = await makeSub("res_x", "handler-x");
    const subY = await makeSub("res_y", "handler-y");

    kv.hgetallKeys.length = 0;
    await unregisterHandler("handler-x");

    // Locally-tracked handler cleanup must not scan subscription hashes.
    expect(kv.hgetallKeys).toEqual([]);
    expect(await getSubscription(subX)).toBeUndefined();
    expect(await getSubscription(subY)).toBeDefined();
    await unregisterHandler("handler-y");
  });

  it("cross-resource introspection still sees everything", async () => {
    registerHandler("handler-i", createMockWriter());
    await makeSub("res_one", "handler-i");
    await makeSub("res_two", "handler-i");

    const stats = await getSubscriptionStats();
    expect(stats.totalSubscriptions).toBe(2);
    expect(stats.subscriptionsByResource.res_one).toBe(1);
    expect(stats.subscriptionsByResource.res_two).toBe(1);

    const listed = await listActiveSubscriptions();
    expect(listed.map((s) => s.resource).sort()).toEqual(["res_one", "res_two"]);

    const forOne = await getSubscriptionsForResource("res_one");
    expect(forOne).toHaveLength(1);
    expect(forOne[0].resource).toBe("res_one");

    const handlerSubs = await getHandlerSubscriptions("handler-i");
    expect(handlerSubs).toHaveLength(2);

    await unregisterHandler("handler-i");
  });

  it("clearAllSubscriptions wipes every resource shard", async () => {
    registerHandler("handler-c", createMockWriter());
    await makeSub("res_c1", "handler-c");
    await makeSub("res_c2", "handler-c");

    await clearAllSubscriptions();

    const stats = await getSubscriptionStats();
    expect(stats.totalSubscriptions).toBe(0);
    expect(await listActiveSubscriptions()).toEqual([]);
  });
});
