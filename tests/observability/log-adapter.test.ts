import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryLogAdapter,
  createKVLogAdapter,
} from "@/observability/log-adapter";
import { createMemoryKV } from "@/kv/memory";
import { setGlobalKV, clearGlobalKV } from "@/kv";

interface Entry {
  n: number;
  timestamp: number;
}

const entry = (n: number, timestamp = n): Entry => ({ n, timestamp });

describe("createInMemoryLogAdapter", () => {
  it("newest-first: append/querySync/limit/offset + cap eviction", async () => {
    const a = createInMemoryLogAdapter<Entry>({ maxEntries: 3, order: "newest-first" });
    a.append(entry(1));
    a.append(entry(2));
    a.append(entry(3));
    a.append(entry(4)); // evicts 1
    expect(a.querySync().map((e) => e.n)).toEqual([4, 3, 2]);
    expect(a.querySync({ limit: 2 }).map((e) => e.n)).toEqual([4, 3]);
    expect(a.querySync({ limit: 2, offset: 1 }).map((e) => e.n)).toEqual([3, 2]);
    expect(a.countSync()).toBe(3);
    expect(await a.count()).toBe(3);
  });

  it("oldest-first: getRecent semantics (tail, chronological) + cap eviction", () => {
    const a = createInMemoryLogAdapter<Entry>({ maxEntries: 3, order: "oldest-first" });
    a.append(entry(1));
    a.append(entry(2));
    a.append(entry(3));
    a.append(entry(4)); // evicts 1
    expect(a.querySync().map((e) => e.n)).toEqual([2, 3, 4]);
    // most-recent 2, chronological — equivalent to arr.slice(-2)
    expect(a.querySync({ limit: 2 }).map((e) => e.n)).toEqual([3, 4]);
  });

  it("filters by since/until", () => {
    const a = createInMemoryLogAdapter<Entry>({ maxEntries: 10, order: "newest-first" });
    [10, 20, 30, 40].forEach((t) => a.append(entry(t, t)));
    expect(a.querySync({ since: 20, until: 30 }).map((e) => e.n).sort()).toEqual([20, 30]);
  });

  it("clear empties the store", () => {
    const a = createInMemoryLogAdapter<Entry>({ maxEntries: 10, order: "newest-first" });
    a.append(entry(1));
    a.clear();
    expect(a.countSync()).toBe(0);
  });
});

describe("createKVLogAdapter", () => {
  beforeEach(() => clearGlobalKV());

  it("without a global KV behaves exactly like the in-memory adapter", async () => {
    const a = createKVLogAdapter<Entry>({ maxEntries: 3, order: "newest-first", keyPrefix: "covara:obs:test" });
    a.append(entry(1));
    a.append(entry(2));
    expect(a.querySync().map((e) => e.n)).toEqual([2, 1]);
    expect(await a.query()).toEqual([entry(2), entry(1)]);
  });

  it("persists to KV and serves authoritative cross-instance reads via query()", async () => {
    const kv = createMemoryKV();
    await kv.connect();
    setGlobalKV(kv);

    const writer = createKVLogAdapter<Entry>({ maxEntries: 100, order: "newest-first", keyPrefix: "covara:obs:x" });
    writer.append(entry(1));
    writer.append(entry(2));
    writer.append(entry(3));
    // allow fire-and-forget persists to settle
    await new Promise((r) => setTimeout(r, 10));

    // A second "instance" with an empty local mirror reads from shared KV.
    const reader = createKVLogAdapter<Entry>({ maxEntries: 100, order: "newest-first", keyPrefix: "covara:obs:x" });
    expect(reader.querySync()).toEqual([]); // local mirror empty
    expect((await reader.query()).map((e) => e.n)).toEqual([3, 2, 1]); // KV authoritative
    expect((await reader.query({ limit: 2 })).map((e) => e.n)).toEqual([3, 2]);
    expect(await reader.count()).toBe(3);

    clearGlobalKV();
  });

  it("caps KV entries via zrem", async () => {
    const kv = createMemoryKV();
    await kv.connect();
    setGlobalKV(kv);

    const a = createKVLogAdapter<Entry>({ maxEntries: 2, order: "newest-first", keyPrefix: "covara:obs:cap" });
    a.append(entry(1));
    a.append(entry(2));
    a.append(entry(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(await a.count()).toBe(2);
    expect((await a.query()).map((e) => e.n)).toEqual([3, 2]);

    clearGlobalKV();
  });

  it("append never throws when the KV layer rejects, and the mirror still records", async () => {
    const throwingKV = {
      incr: async () => {
        throw new Error("kv down");
      },
    };
    setGlobalKV(throwingKV as never);

    const a = createKVLogAdapter<Entry>({ maxEntries: 10, order: "newest-first", keyPrefix: "covara:obs:err" });
    expect(() => a.append(entry(1))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(a.querySync().map((e) => e.n)).toEqual([1]); // mirror recorded it

    clearGlobalKV();
  });
});
