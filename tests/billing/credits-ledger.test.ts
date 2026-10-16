import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import Database from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createMemoryKV } from "@/kv";
import { migrateInternal } from "@/db/migrate";
import { defineInternalSchema } from "@/db/internal-schema";
import {
  createCreditsLedger,
  createDrizzleCreditsLedger,
  CreditsIdempotencyConflictError,
  type CreditsLedger,
} from "@/billing/credits";
import type { DrizzleDatabase } from "@/resource/types";

interface Backend {
  name: string;
  durable: boolean;
  setup(): Promise<{ ledger: CreditsLedger; db?: DrizzleDatabase; teardown(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "kv (memory)",
    durable: false,
    async setup() {
      const kv = createMemoryKV(`ledger-${Date.now()}-${Math.random()}`);
      await kv.connect();
      return { ledger: createCreditsLedger(kv), teardown: () => kv.disconnect() };
    },
  },
  {
    name: "drizzle libsql",
    durable: true,
    async setup() {
      const client = createClient({ url: ":memory:" });
      const db = drizzleLibsql(client);
      await migrateInternal(db);
      return {
        ledger: createDrizzleCreditsLedger({ db }),
        db,
        teardown: async () => client.close(),
      };
    },
  },
  {
    name: "drizzle better-sqlite3",
    durable: true,
    async setup() {
      const sqlite = new Database(":memory:");
      const db = drizzleBetterSqlite(sqlite);
      await migrateInternal(db);
      return {
        ledger: createDrizzleCreditsLedger({ db }),
        db,
        teardown: async () => sqlite.close(),
      };
    },
  },
  {
    name: "drizzle pglite",
    durable: true,
    async setup() {
      const pglite = new PGlite();
      const db = drizzlePglite(pglite);
      await migrateInternal(db);
      return {
        ledger: createDrizzleCreditsLedger({ db }),
        db,
        teardown: () => pglite.close(),
      };
    },
  },
];

for (const backend of backends) {
  describe(`CreditsLedger contract — ${backend.name}`, () => {
    let ledger: CreditsLedger;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const setup = await backend.setup();
      ledger = setup.ledger;
      teardown = setup.teardown;
    });
    afterEach(async () => {
      await teardown();
    });

    it("reports durability", () => {
      expect(ledger.durable).toBe(backend.durable);
    });

    it("an account with no row has a zero balance and empty history", async () => {
      expect(await ledger.balance("nobody")).toBe(0);
      expect(await ledger.history("nobody")).toEqual([]);
    });

    it("grants, consumes, and tracks balance + newest-first history", async () => {
      expect(await ledger.grant("acct", 100, { reason: "signup", metadata: { a: 1 } })).toBe(100);
      const res = await ledger.consume("acct", 30, { reason: "api-call" });
      expect(res).toMatchObject({ ok: true, balance: 70 });
      expect(await ledger.balance("acct")).toBe(70);

      const history = await ledger.history("acct");
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ delta: -30, balance: 70, reason: "api-call" });
      expect(history[1]).toMatchObject({ delta: 100, balance: 100, reason: "signup", metadata: { a: 1 } });
      expect(typeof history[0].at).toBe("number");
    });

    it("refuses to overdraw without recording an entry", async () => {
      await ledger.grant("acct", 10);
      const res = await ledger.consume("acct", 50);
      expect(res).toMatchObject({ ok: false, balance: 10 });
      expect(await ledger.balance("acct")).toBe(10);
      expect(await ledger.history("acct")).toHaveLength(1);
    });

    it("consume on an account with no row fails cleanly", async () => {
      const res = await ledger.consume("ghost", 1);
      expect(res).toMatchObject({ ok: false, balance: 0 });
      expect(await ledger.balance("ghost")).toBe(0);
    });

    it("allowNegative lets the balance go below zero", async () => {
      await ledger.grant("acct", 5);
      const res = await ledger.consume("acct", 8, { allowNegative: true });
      expect(res).toMatchObject({ ok: true, balance: -3 });
      expect(await ledger.balance("acct")).toBe(-3);
      const next = await ledger.consume("acct", 1);
      expect(next.ok).toBe(false);
      expect(await ledger.balance("acct")).toBe(-3);
    });

    it("rejects negative, fractional, and non-finite amounts", async () => {
      await expect(ledger.grant("acct", -1)).rejects.toThrow();
      await expect(ledger.grant("acct", 1.5)).rejects.toThrow();
      await expect(ledger.grant("acct", Number.NaN)).rejects.toThrow();
      await expect(ledger.grant("acct", Number.POSITIVE_INFINITY)).rejects.toThrow();
      await expect(ledger.consume("acct", -1)).rejects.toThrow();
      await expect(ledger.consume("acct", 0.25)).rejects.toThrow();
      await expect(ledger.set("acct", 2.5)).rejects.toThrow();
      expect(await ledger.balance("acct")).toBe(0);
    });

    it("rejects an empty account id", async () => {
      await expect(ledger.grant("", 1)).rejects.toThrow();
    });

    it("set replaces the balance and records the delta", async () => {
      await ledger.grant("acct", 40);
      expect(await ledger.set("acct", 15, { reason: "admin" })).toBe(15);
      expect(await ledger.balance("acct")).toBe(15);
      const [latest] = await ledger.history("acct");
      expect(latest).toMatchObject({ balance: 15, reason: "admin" });
    });

    it("a repeated grant idempotency key applies once and returns the original balance", async () => {
      expect(await ledger.grant("acct", 100, { idempotencyKey: "evt_1" })).toBe(100);
      await ledger.grant("acct", 5);
      expect(await ledger.grant("acct", 100, { idempotencyKey: "evt_1" })).toBe(100);
      expect(await ledger.balance("acct")).toBe(105);
      expect(await ledger.history("acct")).toHaveLength(2);
    });

    it("an idempotency key reused with a different amount throws a conflict", async () => {
      await ledger.grant("acct", 100, { idempotencyKey: "evt_1" });
      await expect(ledger.grant("acct", 200, { idempotencyKey: "evt_1" })).rejects.toBeInstanceOf(
        CreditsIdempotencyConflictError
      );
      expect(await ledger.balance("acct")).toBe(100);
    });

    it("an idempotency key reused for a different operation throws a conflict", async () => {
      await ledger.grant("acct", 100, { idempotencyKey: "k" });
      await expect(ledger.consume("acct", 100, { idempotencyKey: "k" })).rejects.toBeInstanceOf(
        CreditsIdempotencyConflictError
      );
      expect(await ledger.balance("acct")).toBe(100);
    });

    it("idempotency keys are scoped per account", async () => {
      await ledger.grant("a", 10, { idempotencyKey: "same" });
      await ledger.grant("b", 20, { idempotencyKey: "same" });
      expect(await ledger.balance("a")).toBe(10);
      expect(await ledger.balance("b")).toBe(20);
    });

    it("a repeated consume idempotency key debits once and reports duplicate", async () => {
      await ledger.grant("acct", 50);
      const first = await ledger.consume("acct", 20, { idempotencyKey: "req_1" });
      const second = await ledger.consume("acct", 20, { idempotencyKey: "req_1" });
      expect(first).toMatchObject({ ok: true, balance: 30 });
      expect(first.duplicate).toBeFalsy();
      expect(second).toMatchObject({ ok: true, balance: 30, duplicate: true });
      expect(await ledger.balance("acct")).toBe(30);
    });

    it("an insufficient consume does not burn its idempotency key", async () => {
      const failed = await ledger.consume("acct", 20, { idempotencyKey: "req_2" });
      expect(failed.ok).toBe(false);
      await ledger.grant("acct", 50);
      const retried = await ledger.consume("acct", 20, { idempotencyKey: "req_2" });
      expect(retried).toMatchObject({ ok: true, balance: 30 });
    });

    it("set is idempotent with a key", async () => {
      await ledger.set("acct", 70, { idempotencyKey: "s1" });
      await ledger.grant("acct", 1);
      expect(await ledger.set("acct", 70, { idempotencyKey: "s1" })).toBe(70);
      expect(await ledger.balance("acct")).toBe(71);
    });

    it("concurrent consumers never overdraw", async () => {
      await ledger.grant("acct", 100);
      const results = await Promise.all(
        Array.from({ length: 25 }, () => ledger.consume("acct", 10))
      );
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(await ledger.balance("acct")).toBe(0);
      for (const r of results) {
        if (backend.durable || r.ok) expect(r.balance).toBeGreaterThanOrEqual(0);
      }
    });

    it("concurrent grants all land", async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.grant("acct", i + 1)));
      expect(await ledger.balance("acct")).toBe(210);
      expect(await ledger.history("acct", 100)).toHaveLength(20);
    });

    it("concurrent duplicate idempotency keys apply exactly once", async () => {
      await Promise.all(
        Array.from({ length: 10 }, () => ledger.grant("acct", 100, { idempotencyKey: "evt_dup" }))
      );
      expect(await ledger.balance("acct")).toBe(100);
      expect(await ledger.history("acct")).toHaveLength(1);
    });

    it("history respects limit and historyPage walks every entry", async () => {
      for (let i = 1; i <= 7; i++) await ledger.grant("acct", i);
      expect(await ledger.history("acct", 3)).toHaveLength(3);

      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await ledger.historyPage!("acct", { limit: 3, cursor });
        seen.push(...page.entries.map((e) => e.delta));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });
  });
}

describe("KV credits ledger — idempotency leases", () => {
  it("a crashed claim's lease expires instead of blocking the key", async () => {
    const kv = createMemoryKV(`ledger-lease-${Date.now()}-${Math.random()}`);
    await kv.connect();
    const ledger = createCreditsLedger(kv, { idempotencyLeaseMs: 20, pendingWaitMs: 500 });
    await kv.set(
      "covara:credits:idem:acct:evt_crash",
      JSON.stringify({ kind: "grant", amount: 10, token: "dead" }),
      { px: 20 }
    );
    expect(await ledger.grant("acct", 10, { idempotencyKey: "evt_crash" })).toBe(10);
    expect(await ledger.balance("acct")).toBe(10);
    await kv.disconnect();
  });

  it("a duplicate gives up with an error when the other operation stays in flight", async () => {
    const kv = createMemoryKV(`ledger-lease-${Date.now()}-${Math.random()}`);
    await kv.connect();
    const ledger = createCreditsLedger(kv, { pendingWaitMs: 30 });
    await kv.set(
      "covara:credits:idem:acct:evt_busy",
      JSON.stringify({ kind: "grant", amount: 10, token: "other" }),
      { px: 60_000 }
    );
    await expect(ledger.grant("acct", 10, { idempotencyKey: "evt_busy" })).rejects.toThrow(/in progress/);
    expect(await ledger.balance("acct")).toBe(0);
    await kv.disconnect();
  });
});

describe("Drizzle credits ledger — durability specifics", () => {
  it("keeps full, untruncated history past the KV cap", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzleBetterSqlite(sqlite);
    await migrateInternal(db);
    const ledger = createDrizzleCreditsLedger({ db });
    for (let i = 0; i < 1005; i++) await ledger.grant("acct", 1);
    let total = 0;
    let cursor: string | undefined;
    do {
      const page = await ledger.historyPage!("acct", { limit: 400, cursor });
      total += page.entries.length;
      cursor = page.nextCursor;
    } while (cursor);
    expect(total).toBe(1005);
    expect(await ledger.history("acct", 2000)).toHaveLength(1005);
    sqlite.close();
  });

  it("rolls back the balance update when the entry insert fails", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzleBetterSqlite(sqlite);
    await migrateInternal(db);
    const ledger = createDrizzleCreditsLedger({ db, maxRetries: 2 });
    await ledger.grant("acct", 10);
    sqlite
      .prepare(
        `INSERT INTO billing_credit_entries (id, account, seq, kind, delta, balanceAfter, createdAt) VALUES ('rogue', 'acct', 2, 'grant', 0, 0, 0)`
      )
      .run();
    await expect(ledger.grant("acct", 5)).rejects.toThrow();
    expect(await ledger.balance("acct")).toBe(10);
    sqlite.close();
  });

  it("rolls back on Postgres too", async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migrateInternal(db);
    const ledger = createDrizzleCreditsLedger({ db, maxRetries: 2 });
    await ledger.grant("acct", 10);
    await pglite.exec(
      `INSERT INTO billing_credit_entries ("id", "account", "seq", "kind", "delta", "balanceAfter", "createdAt") VALUES ('rogue', 'acct', 2, 'grant', 0, 0, NOW())`
    );
    await expect(ledger.consume("acct", 5)).rejects.toThrow();
    expect(await ledger.balance("acct")).toBe(10);
    await pglite.close();
  });

  it("balance always equals the sum of entry deltas and the latest balanceAfter", async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migrateInternal(db);
    const ledger = createDrizzleCreditsLedger({ db });
    await ledger.grant("acct", 50);
    await Promise.all([
      ledger.consume("acct", 20),
      ledger.consume("acct", 20),
      ledger.consume("acct", 20),
      ledger.grant("acct", 7),
    ]);
    const history = await ledger.history("acct", 100);
    const sum = history.reduce((acc, e) => acc + e.delta, 0);
    const balance = await ledger.balance("acct");
    expect(sum).toBe(balance);
    expect(history[0].balance).toBe(balance);
    expect(balance).toBeGreaterThanOrEqual(0);
    await pglite.close();
  });

  it("works over remapped tables via defineInternalSchema fieldMap", async () => {
    const entries = sqliteTable("my_credit_entries", {
      id: text("id").primaryKey(),
      owner: text("owner").notNull(),
      seq: integer("seq").notNull(),
      kind: text("kind").notNull(),
      delta: integer("delta").notNull(),
      after: integer("after").notNull(),
      reason: text("reason"),
      idem: text("idem"),
      at: integer("at", { mode: "timestamp_ms" }).notNull(),
    });
    const balances = sqliteTable("my_credit_balances", {
      owner: text("owner").primaryKey(),
      balance: integer("balance").notNull(),
      version: integer("version").notNull(),
    });
    const schema = defineInternalSchema({
      creditEntries: {
        table: entries,
        fieldMap: { account: "owner", balanceAfter: "after", idempotencyKey: "idem", createdAt: "at" },
      },
      creditBalances: { table: balances, fieldMap: { account: "owner" } },
    });
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    await migrateInternal(db, { schema });
    const ledger = createDrizzleCreditsLedger({ db, schema });
    await ledger.grant("acct", 9, { idempotencyKey: "x" });
    await ledger.grant("acct", 9, { idempotencyKey: "x" });
    expect(await ledger.consume("acct", 4)).toMatchObject({ ok: true, balance: 5 });
    const history = await ledger.history("acct");
    expect(history.map((e) => e.delta)).toEqual([-4, 9]);
    await expect(
      client.execute("INSERT INTO my_credit_entries (id, owner, seq, kind, delta, after, at) VALUES ('z','acct',1,'grant',0,0,0)")
    ).rejects.toThrow();
    client.close();
  });
});
