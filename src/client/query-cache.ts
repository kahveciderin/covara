import { createLiveQuery, LiveQuery, LiveQueryOptions } from "./live-store";
import type { LiveListResourceClient } from "./types";

export interface CachedQueryEntry<T extends { id: string } = { id: string }> {
  path: string;
  options: LiveQueryOptions;
  query: LiveQuery<T>;
  refCount: number;
}

export type InvalidatePredicate = (path: string, options: LiveQueryOptions) => boolean;
export type InvalidateTarget = string | InvalidatePredicate;

interface LiveQueryFactoryCallbacks {
  onAuthError?: () => void;
  getPendingCount?: () => Promise<number>;
  onIdRemapped?: (optimisticId: string, serverId: string) => void;
  getIdMappings?: () => Map<string, string>;
  hasPendingMutationsForId?: (id: string) => Promise<boolean>;
}

const stableKey = (path: string, options: LiveQueryOptions): string =>
  `${path}::${JSON.stringify({
    filter: options.filter ?? null,
    include: options.include ?? null,
    orderBy: options.orderBy ?? null,
    limit: options.limit ?? null,
    select: options.select ?? null,
    subscriptionMode: options.subscriptionMode ?? null,
  })}`;

const matches = (entry: CachedQueryEntry, target: InvalidateTarget): boolean => {
  if (typeof target === "function") {
    return target(entry.path, entry.options);
  }
  // String: exact path or prefix match (e.g. "/api/todos" matches "/api/todos").
  return entry.path === target || entry.path.startsWith(target);
};

/**
 * Registry of live queries keyed by path + options. Backs `client.invalidate`
 * and `client.prefetch`: it dedupes identical queries (ref-counted), lets the
 * client mark matching stores stale and refetch them, and lets callers warm the
 * cache before a component reads it.
 */
export class LiveQueryCache {
  private entries = new Map<string, CachedQueryEntry>();
  private resolveRepo: <T extends { id: string }>(path: string) => LiveListResourceClient<T>;
  private callbacks: LiveQueryFactoryCallbacks;

  constructor(config: {
    resolveRepo: <T extends { id: string }>(path: string) => LiveListResourceClient<T>;
    callbacks?: LiveQueryFactoryCallbacks;
  }) {
    this.resolveRepo = config.resolveRepo;
    this.callbacks = config.callbacks ?? {};
  }

  /** Acquire (or create) a shared live query and bump its ref count. */
  acquire<T extends { id: string }>(
    path: string,
    options: LiveQueryOptions = {}
  ): LiveQuery<T> {
    const key = stableKey(path, options);
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing.query as unknown as LiveQuery<T>;
    }

    const repo = this.resolveRepo<T>(path);
    const query = createLiveQuery<T>(repo, options, this.callbacks);
    this.entries.set(key, {
      path,
      options,
      query: query as unknown as LiveQuery<{ id: string }>,
      refCount: 1,
    });
    return query;
  }

  /** Release a previously-acquired query; destroys it when the last holder leaves. */
  release(path: string, options: LiveQueryOptions = {}): void {
    const key = stableKey(path, options);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.query.destroy();
      this.entries.delete(key);
    }
  }

  /** Peek an already-cached query without acquiring a reference. */
  peek<T extends { id: string }>(
    path: string,
    options: LiveQueryOptions = {}
  ): LiveQuery<T> | undefined {
    const entry = this.entries.get(stableKey(path, options));
    return entry?.query as unknown as LiveQuery<T> | undefined;
  }

  has(path: string, options: LiveQueryOptions = {}): boolean {
    return this.entries.has(stableKey(path, options));
  }

  /**
   * Warm the cache for a path/options without a component mounting. The created
   * query is held with refCount 0 so it persists until explicitly invalidated or
   * acquired; a later `acquire` reuses it so the first read is immediate.
   */
  async prefetch<T extends { id: string }>(
    path: string,
    options: LiveQueryOptions = {}
  ): Promise<LiveQuery<T>> {
    const key = stableKey(path, options);
    const existing = this.entries.get(key);
    if (existing) {
      await existing.query.refresh();
      return existing.query as unknown as LiveQuery<T>;
    }
    const repo = this.resolveRepo<T>(path);
    const query = createLiveQuery<T>(repo, options, this.callbacks);
    this.entries.set(key, {
      path,
      options,
      query: query as unknown as LiveQuery<{ id: string }>,
      refCount: 0,
    });
    await query.refresh();
    return query;
  }

  /** Mark matching queries stale and refetch them. Returns the count refreshed. */
  invalidate(target: InvalidateTarget): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (matches(entry, target)) {
        count += 1;
        void entry.query.refresh();
      }
    }
    return count;
  }

  /** Destroy every cached query (used on client teardown). */
  destroyAll(): void {
    for (const entry of this.entries.values()) {
      entry.query.destroy();
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
