import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  removeSubscription,
  registerHandler,
  unregisterHandler,
  getSubscriptionsForResource,
  clearAllSubscriptions,
} from "@/resource/subscription";
import { createMemoryKV, setGlobalKV, clearGlobalKV, type KVAdapter } from "@/kv";

const LEASE_MS = 120_000;
const RENEW_MS = 30_000;

const writer = (): SSEWriter => {
  const callbacks: (() => void)[] = [];
  const w = {
    write: vi.fn(() => true),
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    close: vi.fn(() => {
      (w as { closed: boolean }).closed = true;
      for (const cb of callbacks.splice(0)) cb();
    }),
    onClose: (cb: () => void) => void callbacks.push(cb),
  };
  return w;
};

const ids = async (resource: string) => (await getSubscriptionsForResource(resource)).map((s) => s.id);
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("subscription records are leased by the process holding them", () => {
  let kv: KVAdapter;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    kv = createMemoryKV(`lease-${crypto.randomUUID()}`);
    await kv.connect();
    setGlobalKV(kv);
  });

  afterEach(async () => {
    await clearAllSubscriptions();
    vi.useRealTimers();
    clearGlobalKV();
    await kv.disconnect();
  });

  it("a record whose process stopped renewing is dropped and deleted on the next load", async () => {
    const id = await createSubscription({ resource: "items", filter: "", authId: "u1", handlerId: "gone" });
    expect(await ids("items")).toEqual([id]);
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    expect(await ids("items")).toEqual([]);
    expect(await kv.hget("covara:subs:byres:items", id)).toBeNull();
    expect(await kv.hget("covara:subs:lease:items", id)).toBeNull();
    expect(await kv.exists(`covara:sub:seq:${id}`)).toBe(0);
  });

  it("a registered handler keeps its records alive past the lease", async () => {
    const w = writer();
    registerHandler("alive", w);
    const id = await createSubscription({ resource: "items", filter: "", authId: "u1", handlerId: "alive" });
    for (let elapsed = 0; elapsed < LEASE_MS * 3; elapsed += RENEW_MS) {
      await vi.advanceTimersByTimeAsync(RENEW_MS);
      await flush();
    }
    expect(await ids("items")).toEqual([id]);
    expect(w.close).not.toHaveBeenCalled();
    await unregisterHandler("alive");
  });

  it("renewal stops when the handler unregisters", async () => {
    registerHandler("leaving", writer());
    await createSubscription({ resource: "items", filter: "", authId: "u1", handlerId: "leaving" });
    await unregisterHandler("leaving");
    expect(await kv.hgetall("covara:subs:lease:items")).toEqual({});
  });

  it("removeSubscription deletes the lease", async () => {
    const id = await createSubscription({ resource: "items", filter: "", authId: "u1", handlerId: "h" });
    await removeSubscription(id);
    expect(await kv.hget("covara:subs:lease:items", id)).toBeNull();
  });

  it("a live handler whose record was pruned closes its stream so the client resubscribes", async () => {
    const w = writer();
    registerHandler("stalled", w);
    const id = await createSubscription({ resource: "items", filter: "", authId: "u1", handlerId: "stalled" });
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    expect(await ids("items")).toEqual([]);
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    await flush();
    expect(w.close).toHaveBeenCalled();
    expect(await kv.hget("covara:subs:lease:items", id)).toBeNull();
  });

  it("a record written before leases existed gets one lease period, then is dropped", async () => {
    await kv.hset(
      "covara:subs:byres:items",
      "00000000-0000-0000-0000-000000000000:items",
      JSON.stringify({
        id: "00000000-0000-0000-0000-000000000000:items",
        createdAt: new Date(0).toISOString(),
        resource: "items",
        filter: "",
        authId: "u1",
        handlerId: "old-process",
        lastSeq: 0,
      })
    );
    expect(await ids("items")).toEqual(["00000000-0000-0000-0000-000000000000:items"]);
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    expect(await ids("items")).toEqual([]);
  });
});
