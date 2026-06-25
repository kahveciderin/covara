import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BudgetStore, clearBudgetMemoryForTests } from "../src/abuse/budget";
import { setGlobalKV, clearGlobalKV, MemoryKVStore } from "../src/kv";
import type { BudgetClassConfig } from "../src/abuse/config";

const cfg: BudgetClassConfig = { capacity: 100, refillPerMinute: 60 };

describe("BudgetStore (memory fallback)", () => {
  beforeEach(() => {
    clearGlobalKV();
    clearBudgetMemoryForTests();
  });
  afterEach(() => clearBudgetMemoryForTests());

  it("seeds a full bucket on first use", async () => {
    const store = new BudgetStore();
    const r = await store.consume("user:a", 10, cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(90);
  });

  it("rejects when the bucket is exhausted and reports retryAfter", async () => {
    const store = new BudgetStore();
    const now = 1_000_000;
    const first = await store.consume("user:b", 100, cfg, now);
    expect(first.allowed).toBe(true);
    const second = await store.consume("user:b", 5, cfg, now);
    expect(second.allowed).toBe(false);
    // need 5 tokens at 60/min => 5 seconds
    expect(second.retryAfterMs).toBe(5000);
  });

  it("refills over time but never exceeds capacity", async () => {
    const store = new BudgetStore();
    const now = 2_000_000;
    await store.consume("user:c", 100, cfg, now); // drains to 0
    // 30s later => +30 tokens
    const after30s = await store.consume("user:c", 0, cfg, now + 30_000);
    expect(after30s.remaining).toBeCloseTo(30, 5);
    // 10 minutes later, clamps at capacity
    const afterLong = await store.consume("user:c", 0, cfg, now + 600_000);
    expect(afterLong.remaining).toBe(100);
  });

  it("keeps separate buckets per key", async () => {
    const store = new BudgetStore();
    await store.consume("user:d", 100, cfg);
    const other = await store.consume("user:e", 1, cfg);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(99);
  });

  it("cost <= 0 never charges", async () => {
    const store = new BudgetStore();
    const r = await store.consume("user:f", 0, cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(100);
  });

  it("credit refunds tokens without exceeding capacity", async () => {
    const store = new BudgetStore();
    const now = 3_000_000;
    await store.consume("user:g", 50, cfg, now);
    await store.credit("user:g", 20, cfg, now);
    const r = await store.consume("user:g", 0, cfg, now);
    expect(r.remaining).toBe(70);
    await store.credit("user:g", 1000, cfg, now);
    const capped = await store.consume("user:g", 0, cfg, now);
    expect(capped.remaining).toBe(100);
  });

  it("treats refillPerMinute 0 as never-refilling", async () => {
    const store = new BudgetStore();
    const frozen: BudgetClassConfig = { capacity: 10, refillPerMinute: 0 };
    const now = 4_000_000;
    await store.consume("user:h", 10, frozen, now);
    const r = await store.consume("user:h", 1, frozen, now + 600_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("BudgetStore (KV-backed)", () => {
  let kv: MemoryKVStore;
  beforeEach(async () => {
    kv = new MemoryKVStore();
    await kv.connect();
    setGlobalKV(kv);
    clearBudgetMemoryForTests();
  });
  afterEach(() => {
    clearGlobalKV();
    clearBudgetMemoryForTests();
  });

  it("persists bucket state across consume calls via KV", async () => {
    const store = new BudgetStore();
    const now = 5_000_000;
    await store.consume("user:k", 60, cfg, now);
    const r = await store.consume("user:k", 50, cfg, now);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(40);
  });
});
