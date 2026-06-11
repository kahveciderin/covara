import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  enqueueSearchOp,
  drainSearchOutbox,
  getSearchOutboxStats,
} from "@/resource/search-outbox";
import {
  setGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
} from "@/search";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

describe("Search outbox", () => {
  let kv: KVAdapter;

  beforeEach(async () => {
    kv = createMemoryKV(`outbox-${Date.now()}-${Math.random()}`);
    await kv.connect();
    setGlobalKV(kv);
  });

  afterEach(async () => {
    clearGlobalSearch();
    await kv.disconnect();
  });

  it("enqueues and drains an index op into the search backend", async () => {
    const adapter = createMemorySearchAdapter();
    setGlobalSearch(adapter);

    await enqueueSearchOp({ index: "todos", type: "index", docId: "1", document: { id: "1", title: "Hi" } });
    expect((await getSearchOutboxStats()).pending).toBe(1);

    const res = await drainSearchOutbox();
    expect(res.succeeded).toBe(1);
    expect((await getSearchOutboxStats()).pending).toBe(0);
    expect(adapter.getIndex("todos")?.size).toBe(1);
  });

  it("retries on transient failure and eventually converges", async () => {
    let calls = 0;
    const adapter = {
      ...createMemorySearchAdapter(),
      index: async () => {
        calls++;
        if (calls < 3) throw new Error("backend down");
      },
    };
    setGlobalSearch(adapter as any);

    await enqueueSearchOp({ index: "todos", type: "index", docId: "1", document: { id: "1" } });

    // First two drains fail (and schedule a backoff in the future), so we pass an
    // advancing clock to bypass nextAttemptAt and let the op converge.
    let now = Date.now();
    let stats = await getSearchOutboxStats();
    let guard = 0;
    while (stats.pending > 0 && guard++ < 10) {
      now += 10 * 60 * 1000; // jump past any backoff
      await drainSearchOutbox({}, now);
      stats = await getSearchOutboxStats();
    }

    expect(stats.pending).toBe(0);
    expect(stats.dead).toBe(0);
    expect(calls).toBe(3);
  });

  it("parks an op in the dead set after maxAttempts", async () => {
    const adapter = {
      ...createMemorySearchAdapter(),
      index: async () => {
        throw new Error("permanently down");
      },
    };
    setGlobalSearch(adapter as any);

    await enqueueSearchOp({ index: "todos", type: "index", docId: "1", document: { id: "1" } });

    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      now += 10 * 60 * 1000;
      await drainSearchOutbox({ maxAttempts: 3 }, now);
    }

    const stats = await getSearchOutboxStats();
    expect(stats.pending).toBe(0);
    expect(stats.dead).toBe(1);
  });
});
