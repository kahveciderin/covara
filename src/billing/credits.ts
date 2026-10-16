import { and, desc, eq, lt } from "drizzle-orm";
import { getGlobalKV, hasGlobalKV, KVAdapter } from "@/kv";
import type { DrizzleDatabase } from "@/resource/types";
import {
  defineInternalSchema,
  type CreditBalanceKey,
  type CreditEntryKey,
  type InternalSchemaBundle,
  type TableResolver,
} from "@/db/internal-schema";
import { detectDialect } from "@/db/migrate";

export type CreditEntryKind = "grant" | "consume" | "set";

export interface CreditEntry {
  id?: string;
  seq?: number;
  kind?: CreditEntryKind;
  delta: number;
  balance: number;
  reason?: string;
  at: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CreditMutationOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CreditConsumeOptions extends CreditMutationOptions {
  allowNegative?: boolean;
}

export interface CreditConsumeResult {
  ok: boolean;
  balance: number;
  duplicate?: boolean;
}

export interface CreditHistoryPage {
  entries: CreditEntry[];
  nextCursor?: string;
}

export interface CreditsLedger {
  readonly durable?: boolean;
  grant(account: string, amount: number, opts?: CreditMutationOptions): Promise<number>;
  consume(account: string, amount: number, opts?: CreditConsumeOptions): Promise<CreditConsumeResult>;
  balance(account: string): Promise<number>;
  set(
    account: string,
    amount: number,
    opts?: { reason?: string; metadata?: Record<string, unknown>; idempotencyKey?: string }
  ): Promise<number>;
  history(account: string, limit?: number): Promise<CreditEntry[]>;
  historyPage?(account: string, opts?: { limit?: number; cursor?: string }): Promise<CreditHistoryPage>;
}

export class CreditsIdempotencyConflictError extends Error {
  constructor(
    public readonly account: string,
    public readonly idempotencyKey: string
  ) {
    super(
      `Idempotency key "${idempotencyKey}" was already used on account "${account}" for a different credits operation`
    );
    this.name = "CreditsIdempotencyConflictError";
  }
}

const assertAccount = (account: string): void => {
  if (typeof account !== "string" || account.length === 0) {
    throw new Error("credits account must be a non-empty string");
  }
};

const assertAmount = (op: string, amount: number, allowNegative = false): void => {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${op} amount must be a safe integer (got ${amount})`);
  }
  if (!allowNegative && amount < 0) {
    throw new Error(`${op} amount must be >= 0`);
  }
};

interface IdempotencyRecord {
  kind: CreditEntryKind;
  amount: number;
  balance?: number;
  token?: string;
}

const matchesRecord = (record: { kind: CreditEntryKind; amount: number }, kind: CreditEntryKind, amount: number): boolean =>
  record.kind === kind && record.amount === amount;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const BALANCE_PREFIX = "covara:credits:balance:";
const HISTORY_PREFIX = "covara:credits:history:";
const IDEMPOTENCY_PREFIX = "covara:credits:idem:";
const HISTORY_MAX = 1000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface KVCreditsLedgerOptions {
  idempotencyTtlMs?: number;
  // Lease held on an idempotency key while its operation is applied.
  idempotencyLeaseMs?: number;
  // How long a duplicate waits for an in-flight operation before throwing.
  pendingWaitMs?: number;
}

// Non-durable: KV (especially Redis with an eviction policy) is not a system of
// record. History is capped at 1000 entries per account and idempotency keys
// expire after `idempotencyTtlMs`. Prefer createDrizzleCreditsLedger.
export const createCreditsLedger = (kv?: KVAdapter, options: KVCreditsLedgerOptions = {}): CreditsLedger => {
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const leaseMs = options.idempotencyLeaseMs ?? 30_000;
  const pendingWaitMs = options.pendingWaitMs ?? 2_000;
  const resolveKv = (): KVAdapter => {
    if (kv) return kv;
    if (!hasGlobalKV()) {
      throw new Error("Credits ledger requires a KV store. Configure a global KV or pass one in.");
    }
    return getGlobalKV();
  };

  const record = async (
    store: KVAdapter,
    account: string,
    kind: CreditEntryKind,
    delta: number,
    balance: number,
    opts?: CreditMutationOptions
  ): Promise<void> => {
    const entry: CreditEntry = {
      kind,
      delta,
      balance,
      reason: opts?.reason,
      at: Date.now(),
      metadata: opts?.metadata,
      idempotencyKey: opts?.idempotencyKey,
    };
    const key = `${HISTORY_PREFIX}${account}`;
    await store.lpush(key, JSON.stringify(entry));
    await store.ltrim(key, 0, HISTORY_MAX - 1);
  };

  const historyPage = async (
    account: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<CreditHistoryPage> => {
    const store = resolveKv();
    const key = `${HISTORY_PREFIX}${account}`;
    const limit = Math.max(1, opts.limit ?? 50);
    const offset = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0;
    if (offset >= HISTORY_MAX) return { entries: [] };
    const stop = Math.min(offset + limit, HISTORY_MAX) - 1;
    const raw = await store.lrange(key, offset, stop);
    const entries = raw.map((r) => JSON.parse(r) as CreditEntry);
    const next = offset + entries.length;
    const more = entries.length === limit && next < HISTORY_MAX && (await store.llen(key)) > next;
    return { entries, nextCursor: more ? String(next) : undefined };
  };

  type Claim =
    | { state: "claimed"; release(): Promise<void>; commit(balance: number): Promise<void> }
    | { state: "duplicate"; balance: number }
    | { state: "none" };

  const claim = async (
    store: KVAdapter,
    account: string,
    kind: CreditEntryKind,
    amount: number,
    idempotencyKey?: string
  ): Promise<Claim> => {
    if (!idempotencyKey) return { state: "none" };
    const key = `${IDEMPOTENCY_PREFIX}${account}:${idempotencyKey}`;
    const deadline = Date.now() + pendingWaitMs;
    // The claim is a short lease until commit makes it long-lived, so a crash
    // mid-operation cannot block the key for the whole TTL; a caller that finds
    // someone else's live lease waits for its outcome.
    for (;;) {
      const token = crypto.randomUUID();
      const mine: IdempotencyRecord = { kind, amount, token };
      await store.set(key, JSON.stringify(mine), { nx: true, px: leaseMs });
      const raw = await store.get(key);
      const current = raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
      if (current?.token === token) {
        return {
          state: "claimed",
          release: async () => {
            await store.del(key);
          },
          commit: async (balance) => {
            await store.set(key, JSON.stringify({ kind, amount, balance }), { px: idempotencyTtlMs });
          },
        };
      }
      if (current && !matchesRecord(current, kind, amount)) {
        throw new CreditsIdempotencyConflictError(account, idempotencyKey);
      }
      if (current?.balance !== undefined) return { state: "duplicate", balance: current.balance };
      if (Date.now() >= deadline) {
        throw new Error(`Credits operation with idempotency key "${idempotencyKey}" is still in progress`);
      }
      await sleep(10);
    }
  };

  return {
    durable: false,

    async grant(account, amount, opts) {
      assertAccount(account);
      assertAmount("grant", amount);
      const store = resolveKv();
      const c = await claim(store, account, "grant", amount, opts?.idempotencyKey);
      if (c.state === "duplicate") return c.balance;
      try {
        const balance = await store.incrBy(`${BALANCE_PREFIX}${account}`, amount);
        await record(store, account, "grant", amount, balance, opts);
        if (c.state === "claimed") await c.commit(balance);
        return balance;
      } catch (err) {
        if (c.state === "claimed") await c.release();
        throw err;
      }
    },

    async consume(account, amount, opts) {
      assertAccount(account);
      assertAmount("consume", amount);
      const store = resolveKv();
      const c = await claim(store, account, "consume", amount, opts?.idempotencyKey);
      if (c.state === "duplicate") return { ok: true, balance: c.balance, duplicate: true };
      const key = `${BALANCE_PREFIX}${account}`;
      try {
        // Debit first, then compensate: the decrement is atomic, so two
        // concurrent consumers can never both observe enough balance.
        const balance = await store.incrBy(key, -amount);
        if (!opts?.allowNegative && balance < 0) {
          const restored = await store.incrBy(key, amount);
          if (c.state === "claimed") await c.release();
          return { ok: false, balance: restored };
        }
        await record(store, account, "consume", -amount, balance, opts);
        if (c.state === "claimed") await c.commit(balance);
        return { ok: true, balance };
      } catch (err) {
        if (c.state === "claimed") await c.release();
        throw err;
      }
    },

    async balance(account) {
      const store = resolveKv();
      return Number((await store.get(`${BALANCE_PREFIX}${account}`)) ?? 0);
    },

    async set(account, amount, opts) {
      assertAccount(account);
      assertAmount("set", amount, true);
      const store = resolveKv();
      const c = await claim(store, account, "set", amount, opts?.idempotencyKey);
      if (c.state === "duplicate") return c.balance;
      try {
        const key = `${BALANCE_PREFIX}${account}`;
        const previous = Number((await store.get(key)) ?? 0);
        await store.set(key, String(amount));
        await record(store, account, "set", amount - previous, amount, opts);
        if (c.state === "claimed") await c.commit(amount);
        return amount;
      } catch (err) {
        if (c.state === "claimed") await c.release();
        throw err;
      }
    },

    async history(account, limit = 50) {
      return (await historyPage(account, { limit })).entries;
    },

    historyPage,
  };
};

export interface DrizzleCreditsLedgerOptions {
  db: DrizzleDatabase;
  // Bundle from defineInternalSchema; defaults to the built-in
  // billing_credit_entries / billing_credit_balances tables for the db's dialect.
  schema?: InternalSchemaBundle;
  // Optimistic-concurrency retries before giving up under heavy contention.
  maxRetries?: number;
}

type Row = Record<string, unknown>;

interface Executor {
  select(): { from(table: unknown): { where(cond: unknown): QueryChain } };
  insert(table: unknown): { values(v: Row): { onConflictDoNothing(): unknown } & PromiseLike<unknown> };
  update(table: unknown): { set(v: Row): { where(cond: unknown): unknown } };
}

interface QueryChain extends PromiseLike<Row[]> {
  orderBy(...cols: unknown[]): QueryChain;
  limit(n: number): QueryChain;
}

interface RunnableStatement {
  run(): unknown;
}

const toMillis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
};

const parseMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
};


// Durable system-of-record ledger: an append-only entries table plus a
// per-account balances row, written together in one transaction (or atomic
// batch on drivers without interactive transactions, e.g. D1). Concurrency is
// optimistic: each write bumps the balance row's `version` and inserts the
// entry with `seq = version`, which the unique (account, seq) index makes
// impossible for two writers to both commit.
export const createDrizzleCreditsLedger = (options: DrizzleCreditsLedgerOptions): CreditsLedger => {
  const db = options.db as unknown as Executor & {
    resultKind?: string;
    batch?: (items: unknown[]) => Promise<unknown>;
    transaction: (fn: (tx: unknown) => unknown) => unknown;
  };
  const schema = options.schema ?? defineInternalSchema({ dialect: detectDialect(options.db) });
  const entries: TableResolver<CreditEntryKey> = schema.creditEntries;
  const balances: TableResolver<CreditBalanceKey> = schema.creditBalances;
  const maxRetries = options.maxRetries ?? 100;

  const ec = (key: CreditEntryKey) => entries.col(key) as never;
  const bc = (key: CreditBalanceKey) => balances.col(key) as never;

  const runAtomic = async (build: (q: Executor) => unknown[]): Promise<void> => {
    if (db.resultKind === "sync") {
      db.transaction((tx) => {
        for (const statement of build(tx as Executor)) (statement as RunnableStatement).run();
      });
      return;
    }
    if (typeof db.batch === "function") {
      await db.batch(build(db));
      return;
    }
    await db.transaction(async (tx) => {
      for (const statement of build(tx as Executor)) await (statement as PromiseLike<unknown>);
    });
  };

  const toEntry = (row: Row): CreditEntry => {
    const get = (key: CreditEntryKey): unknown => (entries.has(key) ? row[entries.prop(key)] : undefined);
    const reason = get("reason");
    const idempotencyKey = get("idempotencyKey");
    return {
      id: get("id") as string,
      seq: Number(get("seq")),
      kind: get("kind") as CreditEntryKind,
      delta: Number(get("delta")),
      balance: Number(get("balanceAfter")),
      reason: reason == null ? undefined : String(reason),
      at: toMillis(get("createdAt")),
      metadata: parseMetadata(get("metadata")),
      idempotencyKey: idempotencyKey == null ? undefined : String(idempotencyKey),
    };
  };

  const readBalance = async (account: string): Promise<{ balance: number; version: number } | null> => {
    const rows = await db
      .select()
      .from(balances.table)
      .where(eq(bc("account"), account))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { balance: Number(row[balances.prop("balance")]), version: Number(row[balances.prop("version")]) };
  };

  const findByKey = async (account: string, idempotencyKey: string): Promise<CreditEntry | null> => {
    const rows = await db
      .select()
      .from(entries.table)
      .where(and(eq(ec("account"), account), eq(ec("idempotencyKey"), idempotencyKey)))
      .limit(1);
    return rows[0] ? toEntry(rows[0]) : null;
  };

  const ensureBalanceRow = async (account: string): Promise<void> => {
    const row: Row = {
      [balances.prop("account")]: account,
      [balances.prop("balance")]: 0,
      [balances.prop("version")]: 0,
    };
    if (balances.has("updatedAt")) row[balances.prop("updatedAt")] = new Date();
    await (db.insert(balances.table).values(row).onConflictDoNothing() as PromiseLike<unknown>);
  };

  const duplicateOf = (
    existing: CreditEntry,
    account: string,
    idempotencyKey: string,
    kind: CreditEntryKind,
    amount: number
  ): CreditEntry => {
    const recordedAmount = existing.kind === "set" ? existing.balance : Math.abs(existing.delta);
    if (!matchesRecord({ kind: existing.kind ?? "grant", amount: recordedAmount }, kind, amount)) {
      throw new CreditsIdempotencyConflictError(account, idempotencyKey);
    }
    return existing;
  };

  type MutationResult =
    | { applied: true; balance: number }
    | { applied: false; duplicate: true; balance: number }
    | { applied: false; duplicate: false; balance: number };

  const mutate = async (
    account: string,
    kind: CreditEntryKind,
    amount: number,
    opts: CreditMutationOptions & { allowNegative?: boolean } = {}
  ): Promise<MutationResult> => {
    assertAccount(account);
    assertAmount(kind, amount, kind === "set");
    const idempotencyKey = opts.idempotencyKey;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (idempotencyKey) {
        const existing = await findByKey(account, idempotencyKey);
        if (existing) {
          const dup = duplicateOf(existing, account, idempotencyKey, kind, amount);
          return { applied: false, duplicate: true, balance: dup.balance };
        }
      }

      await ensureBalanceRow(account);
      const current = (await readBalance(account)) ?? { balance: 0, version: 0 };
      const delta = kind === "grant" ? amount : kind === "consume" ? -amount : amount - current.balance;
      const next = current.balance + delta;
      if (kind === "consume" && !opts.allowNegative && next < 0) {
        return { applied: false, duplicate: false, balance: current.balance };
      }
      if (!Number.isSafeInteger(next)) throw new Error("credits balance would overflow");

      const now = new Date();
      const entryRow: Row = {
        [entries.prop("id")]: crypto.randomUUID(),
        [entries.prop("account")]: account,
        [entries.prop("seq")]: current.version + 1,
        [entries.prop("kind")]: kind,
        [entries.prop("delta")]: delta,
        [entries.prop("balanceAfter")]: next,
        [entries.prop("idempotencyKey")]: idempotencyKey ?? null,
        [entries.prop("createdAt")]: now,
      };
      if (entries.has("reason")) entryRow[entries.prop("reason")] = opts.reason ?? null;
      if (entries.has("metadata")) entryRow[entries.prop("metadata")] = opts.metadata ?? null;
      const balanceSet: Row = {
        [balances.prop("balance")]: next,
        [balances.prop("version")]: current.version + 1,
      };
      if (balances.has("updatedAt")) balanceSet[balances.prop("updatedAt")] = now;

      try {
        await runAtomic((q) => [
          q
            .update(balances.table)
            .set(balanceSet)
            .where(and(eq(bc("account"), account), eq(bc("version"), current.version))),
          q.insert(entries.table).values(entryRow),
        ]);
        return { applied: true, balance: next };
      } catch (err) {
        lastError = err;
        if (idempotencyKey) {
          const existing = await findByKey(account, idempotencyKey);
          if (existing) {
            const dup = duplicateOf(existing, account, idempotencyKey, kind, amount);
            return { applied: false, duplicate: true, balance: dup.balance };
          }
        }
        const after = await readBalance(account);
        if (!after || after.version === current.version) throw err;
        await sleep(Math.random() * Math.min(25, 2 ** Math.min(attempt, 5)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("credits ledger: write contention retries exhausted");
  };

  const historyPage = async (
    account: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<CreditHistoryPage> => {
    const limit = Math.max(1, opts.limit ?? 50);
    const before = opts.cursor !== undefined ? Number(opts.cursor) : undefined;
    const where =
      before !== undefined && Number.isFinite(before)
        ? and(eq(ec("account"), account), lt(ec("seq"), before))
        : eq(ec("account"), account);
    const rows = await db
      .select()
      .from(entries.table)
      .where(where)
      .orderBy(desc(ec("seq")))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(toEntry);
    const nextCursor = rows.length > limit ? String(page[page.length - 1].seq) : undefined;
    return { entries: page, nextCursor };
  };

  return {
    durable: true,

    async grant(account, amount, opts) {
      return (await mutate(account, "grant", amount, opts)).balance;
    },

    async consume(account, amount, opts) {
      const result = await mutate(account, "consume", amount, opts);
      if (result.applied) return { ok: true, balance: result.balance };
      if (result.duplicate) return { ok: true, balance: result.balance, duplicate: true };
      return { ok: false, balance: result.balance };
    },

    async balance(account) {
      return (await readBalance(account))?.balance ?? 0;
    },

    async set(account, amount, opts) {
      return (await mutate(account, "set", amount, opts)).balance;
    },

    async history(account, limit = 50) {
      return (await historyPage(account, { limit })).entries;
    },

    historyPage,
  };
};
