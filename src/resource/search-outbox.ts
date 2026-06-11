import { v4 as uuidv4 } from "uuid";
import { getGlobalKV, hasGlobalKV } from "@/kv";
import { getGlobalSearch, hasGlobalSearch } from "@/search";
import { getLogger } from "@/server/logger";

// Durable search-indexing outbox. Index/delete operations are persisted to the
// KV (the same durable store used for the changelog and subscriptions) the
// moment a mutation happens, then drained against the search backend with
// bounded retries. This gives at-least-once DB->index convergence: a transient
// search-backend failure or a process restart no longer loses the index update
// — the op stays queued until it succeeds (or is parked in the dead set after
// maxAttempts for manual inspection).

export interface SearchOutboxOp {
  id: string;
  index: string;
  type: "index" | "delete";
  docId: string;
  document?: Record<string, unknown>;
  attempts: number;
  enqueuedAt: number;
  nextAttemptAt: number;
}

export interface SearchOutboxConfig {
  maxAttempts?: number;
  backoffBaseMs?: number;
}

const OUTBOX_HASH = "concave:search:outbox";
const OUTBOX_PENDING = "concave:search:outbox:pending";
const OUTBOX_DEAD = "concave:search:outbox:dead";
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_BASE_MS = 1000;

const backoffMs = (attempts: number, base: number): number =>
  Math.min(base * 2 ** Math.min(attempts, 10), 5 * 60 * 1000);

export const enqueueSearchOp = async (
  op: { index: string; type: "index" | "delete"; docId: string; document?: Record<string, unknown> },
  now: number = Date.now()
): Promise<boolean> => {
  if (!hasGlobalKV()) return false;
  const kv = getGlobalKV();
  const entry: SearchOutboxOp = {
    id: uuidv4(),
    index: op.index,
    type: op.type,
    docId: op.docId,
    document: op.document,
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now,
  };
  await kv.hset(OUTBOX_HASH, entry.id, JSON.stringify(entry));
  await kv.sadd(OUTBOX_PENDING, entry.id);
  return true;
};

const processOp = async (entry: SearchOutboxOp): Promise<void> => {
  const search = getGlobalSearch();
  if (entry.type === "delete") {
    await search.delete(entry.index, entry.docId);
  } else {
    await search.index(entry.index, entry.docId, entry.document ?? {});
  }
};

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export const drainSearchOutbox = async (
  config: SearchOutboxConfig & { batchSize?: number } = {},
  now: number = Date.now()
): Promise<DrainResult> => {
  const result: DrainResult = { processed: 0, succeeded: 0, failed: 0, dead: 0 };
  if (!hasGlobalKV() || !hasGlobalSearch()) return result;

  const kv = getGlobalKV();
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const base = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const batchSize = config.batchSize ?? 100;

  const ids = (await kv.smembers(OUTBOX_PENDING)).slice(0, batchSize);
  for (const id of ids) {
    const raw = await kv.hget(OUTBOX_HASH, id);
    if (!raw) {
      await kv.srem(OUTBOX_PENDING, id);
      continue;
    }
    const entry = JSON.parse(raw) as SearchOutboxOp;
    if (entry.nextAttemptAt > now) continue;

    result.processed++;
    try {
      await processOp(entry);
      await kv.hdel(OUTBOX_HASH, id);
      await kv.srem(OUTBOX_PENDING, id);
      result.succeeded++;
    } catch (err) {
      entry.attempts++;
      if (entry.attempts >= maxAttempts) {
        await kv.srem(OUTBOX_PENDING, id);
        await kv.sadd(OUTBOX_DEAD, id);
        await kv.hset(OUTBOX_HASH, id, JSON.stringify(entry));
        result.dead++;
        getLogger().error("Search outbox op exhausted retries (parked in dead set)", {
          index: entry.index,
          operation: entry.type,
          docId: entry.docId,
          attempts: entry.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        entry.nextAttemptAt = now + backoffMs(entry.attempts, base);
        await kv.hset(OUTBOX_HASH, id, JSON.stringify(entry));
        result.failed++;
      }
    }
  }

  return result;
};

export const getSearchOutboxStats = async (): Promise<{ pending: number; dead: number }> => {
  if (!hasGlobalKV()) return { pending: 0, dead: 0 };
  const kv = getGlobalKV();
  const [pending, dead] = await Promise.all([
    kv.smembers(OUTBOX_PENDING),
    kv.smembers(OUTBOX_DEAD),
  ]);
  return { pending: pending.length, dead: dead.length };
};

let drainerHandle: ReturnType<typeof setInterval> | null = null;

// Start a background drainer (Node). On Workers there is no long-lived process,
// so call drainSearchOutbox() from a scheduled handler / cron / queue consumer
// instead.
export const startSearchOutboxDrainer = (
  config: SearchOutboxConfig & { intervalMs?: number } = {}
): (() => void) => {
  if (drainerHandle) return stopSearchOutboxDrainer;
  const intervalMs = config.intervalMs ?? 2000;
  drainerHandle = setInterval(() => {
    void drainSearchOutbox(config).catch(() => {
      // drain errors are per-op handled; a top-level failure shouldn't crash
    });
  }, intervalMs);
  if (typeof (drainerHandle as { unref?: () => void }).unref === "function") {
    (drainerHandle as { unref?: () => void }).unref!();
  }
  return stopSearchOutboxDrainer;
};

export const stopSearchOutboxDrainer = (): void => {
  if (drainerHandle) {
    clearInterval(drainerHandle);
    drainerHandle = null;
  }
};
