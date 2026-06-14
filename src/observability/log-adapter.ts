import { getGlobalKV, hasGlobalKV, type KVAdapter } from "@/kv";

export type LogOrder = "newest-first" | "oldest-first";

export interface LogQuery {
  limit?: number;
  offset?: number;
  /** Lower bound (inclusive) on entry timestamp in ms. */
  since?: number;
  /** Upper bound (inclusive) on entry timestamp in ms. */
  until?: number;
}

/**
 * A pluggable backend for an append-only observability log (admin audit log,
 * request/error logs, metrics). Reads come in a synchronous local-mirror flavor
 * (`querySync`, for hot/render paths that cannot await) and an authoritative
 * async flavor (`query`, which consults KV when available).
 *
 * `append` must never throw into the audited/served action.
 */
export interface ObservabilityLogAdapter<TEntry> {
  append(entry: TEntry): void | Promise<void>;
  querySync(query?: LogQuery): TEntry[];
  query(query?: LogQuery): Promise<TEntry[]>;
  export(opts?: { limit?: number }): Promise<TEntry[]>;
  count(): Promise<number>;
  countSync(): number;
  clear(): void | Promise<void>;
}

export interface LogAdapterOptions<TEntry> {
  maxEntries: number;
  order: LogOrder;
  /** Extract the ms timestamp used for since/until filtering. Default: entry.timestamp. */
  timestampOf?: (entry: TEntry) => number | undefined;
  /** KV key prefix; when set the adapter persists to KV (and falls back to memory). */
  keyPrefix?: string;
  /** Max entries returned by export(). Default 1000. */
  maxExport?: number;
  onError?: (error: Error) => void;
}

const matchesRange = <T>(
  entry: T,
  ts: (e: T) => number | undefined,
  q?: LogQuery
): boolean => {
  if (!q || (q.since == null && q.until == null)) return true;
  const t = ts(entry);
  if (t == null) return true;
  if (q.since != null && t < q.since) return false;
  if (q.until != null && t > q.until) return false;
  return true;
};

// Slice a windowed page out of an array stored in `order` orientation.
// newest-first: index 0 is newest -> slice(offset, offset+limit) is the newest page.
// oldest-first: index 0 is oldest -> the most-recent window (tail), kept chronological.
const pageOf = <T>(arr: T[], order: LogOrder, q?: LogQuery): T[] => {
  const offset = q?.offset ?? 0;
  const limit = q?.limit;
  if (order === "newest-first") {
    return arr.slice(offset, limit == null ? undefined : offset + limit);
  }
  const end = arr.length - offset;
  const start = limit == null ? 0 : Math.max(0, end - limit);
  return arr.slice(Math.max(0, start), Math.max(0, end));
};

export const createInMemoryLogAdapter = <TEntry>(
  options: LogAdapterOptions<TEntry>
): ObservabilityLogAdapter<TEntry> => {
  const { maxEntries, order } = options;
  const ts = options.timestampOf ?? ((e: TEntry) => (e as { timestamp?: number }).timestamp);
  const maxExport = options.maxExport ?? 1000;
  const store: TEntry[] = [];

  const pushLocal = (entry: TEntry): void => {
    if (order === "newest-first") {
      store.unshift(entry);
      if (store.length > maxEntries) store.pop();
    } else {
      store.push(entry);
      if (store.length > maxEntries) store.splice(0, store.length - maxEntries);
    }
  };

  const readLocal = (q?: LogQuery): TEntry[] => {
    const filtered =
      q && (q.since != null || q.until != null)
        ? store.filter((e) => matchesRange(e, ts, q))
        : store;
    return pageOf(filtered, order, q);
  };

  return {
    append: (entry) => pushLocal(entry),
    querySync: (q) => readLocal(q),
    query: async (q) => readLocal(q),
    export: async (opts) => readLocal({ limit: opts?.limit ?? maxExport }),
    count: async () => store.length,
    countSync: () => store.length,
    clear: () => {
      store.length = 0;
    },
  };
};

const getKV = (): KVAdapter | null => (hasGlobalKV() ? getGlobalKV() : null);

/**
 * Hybrid adapter: maintains an in-memory mirror (so `querySync` always works and
 * a KV outage degrades to memory) and, when a global KV store is configured,
 * also persists to a KV sorted set (shared across instances). Modeled on the
 * changelog manager.
 */
export const createKVLogAdapter = <TEntry>(
  options: LogAdapterOptions<TEntry> & { keyPrefix: string }
): ObservabilityLogAdapter<TEntry> => {
  const { maxEntries, order, keyPrefix } = options;
  const ts = options.timestampOf ?? ((e: TEntry) => (e as { timestamp?: number }).timestamp);
  const maxExport = options.maxExport ?? 1000;
  const onError = options.onError;
  const seqKey = `${keyPrefix}:seq`;
  const entriesKey = `${keyPrefix}:entries`;

  const mirror = createInMemoryLogAdapter<TEntry>(options);

  const persist = async (entry: TEntry): Promise<void> => {
    const kv = getKV();
    if (!kv) return;
    try {
      const seq = await kv.incr(seqKey);
      await kv.zadd(entriesKey, seq, JSON.stringify(entry));
      const count = await kv.zcard(entriesKey);
      if (count > maxEntries) {
        const old = await kv.zrange(entriesKey, 0, count - maxEntries - 1);
        if (old.length > 0) await kv.zrem(entriesKey, ...old);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const readKV = async (q?: LogQuery): Promise<TEntry[] | null> => {
    const kv = getKV();
    if (!kv) return null;
    try {
      const count = await kv.zcard(entriesKey);
      if (count === 0) return [];
      const offset = q?.offset ?? 0;
      const limit = q?.limit;
      let start: number;
      let stop: number;
      if (limit == null) {
        start = 0;
        stop = count - 1 - offset;
      } else {
        start = Math.max(0, count - offset - limit);
        stop = count - 1 - offset;
      }
      if (stop < 0 || start > stop) return [];
      const raw = await kv.zrange(entriesKey, start, stop);
      let entries = raw.map((d) => JSON.parse(d) as TEntry);
      if (order === "newest-first") entries = entries.reverse();
      if (q && (q.since != null || q.until != null)) {
        entries = entries.filter((e) => matchesRange(e, ts, q));
      }
      return entries;
    } catch (error) {
      onError?.(error as Error);
      return null;
    }
  };

  return {
    append: (entry) => {
      mirror.append(entry);
      // Fire-and-forget; persist swallows its own errors.
      void persist(entry);
    },
    querySync: (q) => mirror.querySync(q),
    query: async (q) => {
      const fromKV = await readKV(q);
      return fromKV ?? mirror.querySync(q);
    },
    export: async (opts) => {
      const q = { limit: opts?.limit ?? maxExport };
      const fromKV = await readKV(q);
      return fromKV ?? mirror.querySync(q);
    },
    count: async () => {
      const kv = getKV();
      if (kv) {
        try {
          return await kv.zcard(entriesKey);
        } catch (error) {
          onError?.(error as Error);
        }
      }
      return mirror.countSync();
    },
    countSync: () => mirror.countSync(),
    clear: async () => {
      const kv = getKV();
      if (kv) {
        try {
          await kv.del(seqKey, entriesKey);
        } catch (error) {
          onError?.(error as Error);
        }
      }
      mirror.clear();
    },
  };
};
