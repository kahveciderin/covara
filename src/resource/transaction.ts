import { is } from "drizzle-orm";
import { DrizzleD1Database } from "drizzle-orm/d1";

const detectionCache = new WeakMap<object, boolean>();

/**
 * Whether a drizzle db supports interactive (`db.transaction(fn)`) transactions.
 *
 * Cloudflare D1 does not: drizzle implements `transaction()` by issuing raw
 * `BEGIN`/`COMMIT`, which D1 rejects (every statement auto-commits; the atomic
 * primitive is `db.batch()`). libsql, better-sqlite3, postgres-js, Neon and
 * PGlite all support interactive transactions.
 *
 * Pass `override` to bypass detection (e.g. `transactions: false` in resource
 * config, or a custom engine that the heuristic can't classify).
 */
export const supportsInteractiveTransactions = (
  db: unknown,
  override?: boolean
): boolean => {
  if (typeof override === "boolean") return override;
  if (!db || typeof (db as { transaction?: unknown }).transaction !== "function") {
    return false;
  }
  const key = db as object;
  const cached = detectionCache.get(key);
  if (cached !== undefined) return cached;

  let supported = true;
  try {
    if (is(db, DrizzleD1Database)) supported = false;
  } catch {
    // `is()` throws only for non-entities; treat anything with a transaction()
    // we can't classify as supporting it.
    supported = true;
  }
  detectionCache.set(key, supported);
  return supported;
};

export interface TxRunner {
  /** True when the engine supports interactive transactions (everything but D1). */
  readonly interactive: boolean;
  /**
   * Run `fn` inside a transaction when supported; otherwise (D1) run it directly
   * against the db. A single write statement still auto-commits atomically on D1;
   * multi-statement atomicity is the caller's responsibility (e.g. `db.batch`).
   */
  run<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export const makeTxRunner = (db: any, override?: boolean): TxRunner => {
  const interactive = supportsInteractiveTransactions(db, override);
  return {
    interactive,
    run<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return interactive ? db.transaction(fn) : fn(db);
    },
  };
};
