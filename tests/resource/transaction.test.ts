import { describe, it, expect, vi } from "vitest";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import {
  supportsInteractiveTransactions,
  makeTxRunner,
} from "@/resource/transaction";

// Minimal D1Database binding — only needs to be structurally valid for
// `drizzle()` to construct a DrizzleD1Database. No SQL is executed here.
const stubD1Binding = () => {
  const prepare = vi.fn(() => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      run: async () => ({}),
      raw: async () => [],
      first: async () => null,
    }),
  }));
  return {
    prepare,
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    dump: vi.fn(),
    withSession: vi.fn(),
  } as any;
};

describe("transaction capability detection", () => {
  it("reports interactive transactions for libsql", () => {
    const db = drizzleLibsql(createClient({ url: ":memory:" }));
    expect(supportsInteractiveTransactions(db)).toBe(true);
  });

  it("reports NO interactive transactions for Cloudflare D1", () => {
    const binding = stubD1Binding();
    const db = drizzleD1(binding);
    expect(supportsInteractiveTransactions(db)).toBe(false);
    // Detection must not touch the database (no BEGIN probe).
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it("honors an explicit override either way", () => {
    const db = drizzleLibsql(createClient({ url: ":memory:" }));
    expect(supportsInteractiveTransactions(db, false)).toBe(false);
    const d1 = drizzleD1(stubD1Binding());
    expect(supportsInteractiveTransactions(d1, true)).toBe(true);
  });
});

describe("makeTxRunner", () => {
  it("routes through db.transaction when interactive", async () => {
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn("TX"));
    const db = { transaction } as any;
    const runner = makeTxRunner(db, true);
    expect(runner.interactive).toBe(true);
    const result = await runner.run(async (tx) => {
      expect(tx).toBe("TX");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("runs fn directly against the db when transactions are unavailable (D1)", async () => {
    const binding = stubD1Binding();
    const db = drizzleD1(binding);
    const runner = makeTxRunner(db);
    expect(runner.interactive).toBe(false);

    const received: unknown[] = [];
    const result = await runner.run(async (tx) => {
      received.push(tx);
      return 42;
    });
    expect(result).toBe(42);
    // fn receives the db itself, and db.transaction (BEGIN/COMMIT) is never used.
    expect(received[0]).toBe(db);
    expect(binding.prepare).not.toHaveBeenCalled();
  });
});
