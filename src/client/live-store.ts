import type { LiveListResourceClient, SubscriptionCallbacks, Subscription, EventMeta, ListOptions, SubscribeOptions } from "./types";

export type LiveQueryStatus = "loading" | "live" | "reconnecting" | "offline" | "error";

export type SubscriptionMode = "strict" | "sorted" | "append" | "prepend" | "live";

export interface LiveQueryState<T> {
  items: T[];
  status: LiveQueryStatus;
  error: Error | null;
  pendingCount: number;
  lastSeq: number;
  hasMore: boolean;
  totalCount?: number;
  isLoadingMore: boolean;
}

export interface LiveQueryMutations<T extends { id: string }> {
  create: (data: Partial<Omit<T, "id">>) => string;
  update: (id: string, data: Partial<T>) => void;
  delete: (id: string) => void;
}

export interface LiveQuery<T extends { id: string }> {
  getSnapshot: () => LiveQueryState<T>;
  subscribe: (listener: () => void) => () => void;
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  destroy: () => void;
}

export interface LiveQueryOptions {
  filter?: string;
  include?: string;
  orderBy?: string;
  limit?: number;
  subscriptionMode?: SubscriptionMode;
  select?: string[];
}

type SortFn<T> = (a: T, b: T) => number;

interface OrderMarkers {
  __appendedAt?: number;
  __prependedAt?: number;
}

const markersOf = <T>(item: T): OrderMarkers => item as T & OrderMarkers;

const createSortFn = <T>(orderBy?: string): SortFn<T> | null => {
  if (!orderBy) return null;

  // Accept both "field:desc" and the "-field" (JSON:API) descending syntax,
  // matching the server's parseOrderBy.
  const parts = orderBy
    .split(",")
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const [rawField, dir] = part.split(":");
      let field = rawField.trim();
      let desc = dir?.toLowerCase() === "desc";
      if (field.startsWith("-")) { field = field.slice(1); desc = true; }
      else if (field.startsWith("+")) { field = field.slice(1); }
      return { field, desc };
    });

  return (a: T, b: T) => {
    for (const { field, desc } of parts) {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];

      if (aVal === bVal) continue;
      if (aVal === null || aVal === undefined) return desc ? -1 : 1;
      if (bVal === null || bVal === undefined) return desc ? 1 : -1;

      const cmp = aVal < bVal ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  };
};

export const createLiveQuery = <T extends { id: string }>(
  repo: LiveListResourceClient<T>,
  options: LiveQueryOptions = {},
  callbacks?: {
    onAuthError?: () => void;
    getPendingCount?: () => Promise<number>;
    onIdRemapped?: (optimisticId: string, serverId: string) => void;
    getIdMappings?: () => Map<string, string>;
    hasPendingMutationsForId?: (id: string) => Promise<boolean>;
  }
): LiveQuery<T> => {
  const cache = new Map<string, T>();
  const optimisticIds = new Set<string>();
  const pendingDeletes = new Set<string>();
  const pendingUpdates = new Map<string, Partial<T>>();
  const pendingRemoteChanges = new Map<string, T>(); // Changes that arrived for items not yet in cache
  const idMappings = new Map<string, string>();
  const listeners = new Set<() => void>();
  let subscription: Subscription<T> | null = null;
  let status: LiveQueryStatus = "loading";
  let error: Error | null = null;
  let pendingCount = 0;
  let lastSeq = 0;
  let destroyed = false;
  let hasMore = false;
  let totalCount: number | undefined;
  let isLoadingMore = false;
  let nextCursor: string | null = null;

  // Keep the requested totalCount in sync with live membership changes so a
  // "N of M loaded" UI doesn't go stale after the user adds/removes a row.
  // No-op until the initial fetch populates totalCount (and `refresh()` re-reads
  // the authoritative server total, healing any drift).
  const bumpTotal = (delta: number) => {
    if (totalCount !== undefined) {
      totalCount = Math.max(0, totalCount + delta);
    }
  };

  const sortFn = createSortFn<T>(options.orderBy);

  // Cached snapshot for useSyncExternalStore compatibility
  let cachedSnapshot: LiveQueryState<T> = {
    items: [],
    status: "loading",
    error: null,
    pendingCount: 0,
    lastSeq: 0,
    hasMore: false,
    totalCount: undefined,
    isLoadingMore: false,
  };

  const getSortedItems = (): T[] => {
    const items = Array.from(cache.values());

    // Separate prepended, normal, and appended items
    const prepended = items.filter(i => markersOf(i).__prependedAt);
    const appended = items.filter(i => markersOf(i).__appendedAt);
    const normal = items.filter(i => !markersOf(i).__prependedAt && !markersOf(i).__appendedAt);

    // Sort each group
    if (sortFn) {
      prepended.sort((a, b) => (markersOf(b).__prependedAt ?? 0) - (markersOf(a).__prependedAt ?? 0)); // newest first
      normal.sort(sortFn);
      appended.sort((a, b) => (markersOf(a).__appendedAt ?? 0) - (markersOf(b).__appendedAt ?? 0)); // oldest first
    }

    return [...prepended, ...normal, ...appended];
  };

  const updateSnapshot = () => {
    cachedSnapshot = {
      items: getSortedItems(),
      status,
      error,
      pendingCount,
      lastSeq,
      hasMore,
      totalCount,
      isLoadingMore,
    };
  };

  const notify = () => {
    updateSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };

  const updatePendingCount = async () => {
    if (callbacks?.getPendingCount) {
      pendingCount = await callbacks.getPendingCount();
      notify();
    }
  };

  const handleAdd = (item: T, meta?: EventMeta) => {
    const optimisticId = meta?.optimisticId;
    const effectiveMode = options.subscriptionMode ?? (options.limit ? "strict" : "live");

    // If this item (or its optimistic version) has a pending delete, don't add it
    if (pendingDeletes.has(item.id)) {
      return;
    }
    if (optimisticId && pendingDeletes.has(optimisticId)) {
      // Clean up the pending delete since server confirmed addition
      pendingDeletes.delete(optimisticId);
    }

    // Mode-specific logic for non-optimistic adds (server-pushed items from other clients)
    if (!optimisticId) {
      switch (effectiveMode) {
        case "strict":
          // Only show items we explicitly fetched - ignore server-pushed adds
          return;
        case "sorted":
          // Show new items - sorting happens in getSortedItems()
          break;
        case "append":
          // Mark item to be placed at end
          markersOf(item).__appendedAt = Date.now();
          break;
        case "prepend":
          // Mark item to be placed at start
          markersOf(item).__prependedAt = Date.now();
          break;
        case "live":
          // Show everything (current behavior)
          break;
      }
    }

    // Was this row already counted? Either it reconciles one of our optimistic
    // creates (already counted at create time) or it's already in the cache.
    const alreadyCounted = cache.has(item.id);
    let reconcilesOptimistic = false;

    if (optimisticId && optimisticIds.has(optimisticId)) {
      reconcilesOptimistic = true;
      cache.delete(optimisticId);
      optimisticIds.delete(optimisticId);
      idMappings.set(optimisticId, item.id);
      callbacks?.onIdRemapped?.(optimisticId, item.id);

      // Transfer any pending updates from optimistic ID to server ID
      const pendingUpdate = pendingUpdates.get(optimisticId);
      if (pendingUpdate) {
        pendingUpdates.delete(optimisticId);
        pendingUpdates.set(item.id, pendingUpdate);
      }
    }

    const mappedOptimisticId = Array.from(idMappings.entries()).find(
      ([, serverId]) => serverId === item.id
    )?.[0];

    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      reconcilesOptimistic = true;
      cache.delete(mappedOptimisticId);
    }

    // Apply any pending updates to the item
    let finalItem = item;
    const pendingUpdate = pendingUpdates.get(item.id);
    if (pendingUpdate) {
      finalItem = { ...item, ...pendingUpdate };
    }

    cache.set(item.id, finalItem);
    if (!reconcilesOptimistic && !alreadyCounted) bumpTotal(1);
    notify();
  };

  const handleExisting = async (item: T) => {
    // Check if this item has a pending delete - if so, don't add it back
    if (pendingDeletes.has(item.id)) {
      return;
    }

    // Check if this item's ID is a server ID that maps to an optimistic ID
    // This handles the case where the subscription reconnects after offline sync
    // and the added event with optimisticId metadata was missed

    // Find the optimistic ID that maps to this server ID
    let mappedOptimisticId: string | undefined;

    // First check our local idMappings (optimisticId -> serverId)
    for (const [optId, serverId] of idMappings.entries()) {
      if (serverId === item.id) {
        mappedOptimisticId = optId;
        break;
      }
    }

    // Also check external ID mappings (from OfflineManager)
    if (!mappedOptimisticId && callbacks?.getIdMappings) {
      const externalMappings = callbacks.getIdMappings();
      // externalMappings is optimisticId -> serverId, so we need to find by serverId
      for (const [optimisticId, serverId] of externalMappings) {
        if (serverId === item.id) {
          mappedOptimisticId = optimisticId;
          break;
        }
      }
    }

    // Check if the mapped optimistic ID has a pending delete
    if (mappedOptimisticId && pendingDeletes.has(mappedOptimisticId)) {
      return;
    }

    // If we found a mapping and have the optimistic item in cache
    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      // Check if there are pending mutations for this item
      // If so, DON'T replace - keep the optimistic state until mutations sync
      if (callbacks?.hasPendingMutationsForId) {
        const hasPending = await callbacks.hasPendingMutationsForId(mappedOptimisticId);
        if (hasPending) {
          // Don't replace optimistic item - it has pending changes
          // Update our local idMappings for when the mutations complete
          idMappings.set(mappedOptimisticId, item.id);
          return;
        }
      }

      // No pending mutations - safe to replace
      cache.delete(mappedOptimisticId);
      optimisticIds.delete(mappedOptimisticId);
      idMappings.set(mappedOptimisticId, item.id);
    }

    // Apply any pending updates to the item
    let finalItem = item;
    const pendingUpdate = pendingUpdates.get(item.id);
    if (pendingUpdate) {
      finalItem = { ...item, ...pendingUpdate };
    }
    // Also check for pending updates on the mapped optimistic ID
    if (mappedOptimisticId) {
      const optPendingUpdate = pendingUpdates.get(mappedOptimisticId);
      if (optPendingUpdate) {
        finalItem = { ...finalItem, ...optPendingUpdate };
      }
    }

    cache.set(item.id, finalItem);
    notify();
  };

  const handleChange = (item: T) => {
    const effectiveMode = options.subscriptionMode ?? (options.limit ? "strict" : "live");

    // Check if item is already in cache
    const isInCache = cache.has(item.id);

    // Mode-specific logic: only update items already in cache for non-live modes
    switch (effectiveMode) {
      case "strict":
      case "sorted":
      case "append":
      case "prepend":
        // Only update items already in cache
        if (!isInCache) {
          // Also check if item maps to an optimistic ID in cache
          let foundInCache = false;
          for (const [optId, serverId] of idMappings.entries()) {
            if (serverId === item.id && cache.has(optId)) {
              foundInCache = true;
              break;
            }
          }
          if (callbacks?.getIdMappings) {
            const externalMappings = callbacks.getIdMappings();
            for (const [optimisticId, serverId] of externalMappings) {
              if (serverId === item.id && cache.has(optimisticId)) {
                foundInCache = true;
                break;
              }
            }
          }
          if (!foundInCache) {
            // Store the change for later - it might be for an item being loaded via loadMore
            // This handles the race condition where a change event arrives during loadMore
            pendingRemoteChanges.set(item.id, item);
            return;
          }
        }
        break;
      case "live":
        // Update/add all items (current behavior)
        break;
    }

    // Check if this change is for an item that was optimistically created
    // If so, we need to clean up the optimistic entry. idMappings is keyed
    // optimisticId -> serverId, so match on the value and return the key.
    const mappedOptimisticId = Array.from(idMappings.entries()).find(
      ([, serverId]) => serverId === item.id
    )?.[0];

    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      cache.delete(mappedOptimisticId);
      optimisticIds.delete(mappedOptimisticId);
    }

    // Also check external mappings
    if (callbacks?.getIdMappings) {
      const externalMappings = callbacks.getIdMappings();
      for (const [optimisticId, serverId] of externalMappings) {
        if (serverId === item.id && cache.has(optimisticId)) {
          cache.delete(optimisticId);
          optimisticIds.delete(optimisticId);
          idMappings.set(optimisticId, item.id);
        }
      }
    }

    // Merge with existing item to preserve included relations and internal markers
    // The server's changed event only contains the raw item data, not included relations
    // like category, tags, etc. We need to preserve those from the existing cached item.
    const existing = cache.get(item.id);
    let finalItem = item;
    if (existing) {
      // Start with existing item, then overlay with new item's properties
      // This preserves any properties that exist on existing but not on new item
      // (like included relations: category, tags, etc.)
      finalItem = { ...existing, ...item };

      // Detect stale relations: if a foreign key changed, clear the corresponding relation
      // unless the server included new relation data in the event
      // e.g., if categoryId changed from "cat-1" to "cat-2", clear "category" unless
      // the server included a new "category" object
      for (const key of Object.keys(item)) {
        if (key.endsWith("Id") && key.length > 2) {
          const relationKey = key.slice(0, -2); // categoryId -> category
          const oldFkValue = (existing as Record<string, unknown>)[key];
          const newFkValue = (item as Record<string, unknown>)[key];
          // Check if this foreign key changed (including from value to null or vice versa)
          if (oldFkValue !== newFkValue) {
            // Foreign key changed - clear the relation unless server included new data
            if (!(relationKey in item)) {
              delete (finalItem as Record<string, unknown>)[relationKey];
            }
          }
        }
      }

      // Also preserve internal markers (__appendedAt, __prependedAt)
      const appendedAt = markersOf(existing).__appendedAt;
      const prependedAt = markersOf(existing).__prependedAt;
      if (appendedAt !== undefined) {
        markersOf(finalItem).__appendedAt = appendedAt;
      }
      if (prependedAt !== undefined) {
        markersOf(finalItem).__prependedAt = prependedAt;
      }
    }

    cache.set(item.id, finalItem);
    notify();
  };

  const handleRemove = (id: string) => {
    // Only adjust the total if we were actually still counting this row — an
    // optimistic delete already decremented it, so the later server "removed"
    // event must not double-count.
    if (cache.has(id)) bumpTotal(-1);
    cache.delete(id);
    optimisticIds.delete(id);
    // Server confirmed removal, clear pending delete
    pendingDeletes.delete(id);
    notify();
  };

  const handleInvalidate = async () => {
    status = "loading";
    notify();
    await refresh();
  };

  // Helper to check online status across platforms (browser, React Native, Node)
  const isOnline = (): boolean => {
    if (typeof navigator !== "undefined" && "onLine" in navigator) {
      return navigator.onLine;
    }
    // Assume online if we can't detect (Node.js, React Native without NetInfo)
    return true;
  };

  const handleConnected = (seq: number) => {
    lastSeq = seq;
    status = isOnline() ? "live" : "offline";
    notify();
  };

  const handleDisconnected = () => {
    status = isOnline() ? "reconnecting" : "offline";
    notify();
  };

  const handleError = (err: Error) => {
    if ((err as { status?: number }).status === 401) {
      callbacks?.onAuthError?.();
      return;
    }
    error = err;
    status = "error";
    notify();
  };

  const subscriptionCallbacks: SubscriptionCallbacks<T> = {
    onAdded: handleAdd,
    onExisting: handleExisting,
    onChanged: handleChange,
    onRemoved: handleRemove,
    onInvalidate: handleInvalidate,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    onError: handleError,
  };

  const refresh = async () => {
    if (destroyed) return;
    try {
      const listOptions: ListOptions = {
        totalCount: true,
      };
      if (options.filter) listOptions.filter = options.filter;
      if (options.include) listOptions.include = options.include;
      if (options.orderBy) listOptions.orderBy = options.orderBy;
      if (options.limit) listOptions.limit = options.limit;
      if (options.select) listOptions.select = options.select;

      const result = await repo.list(listOptions);

      // Update pagination state
      hasMore = result.hasMore;
      nextCursor = result.nextCursor;
      totalCount = result.totalCount;

      // Save optimistic items before clearing cache
      const optimisticItems = new Map<string, T>();
      for (const optId of optimisticIds) {
        const item = cache.get(optId);
        if (item) {
          optimisticItems.set(optId, item);
        }
      }

      cache.clear();

      // Add server items, but skip items with pending deletes
      // and apply pending updates
      for (const item of result.items) {
        // Skip items with pending deletes
        if (pendingDeletes.has(item.id)) {
          continue;
        }

        // Check if any optimistic ID maps to this server ID
        let mappedOptId: string | undefined;
        for (const [optId, serverId] of idMappings.entries()) {
          if (serverId === item.id) {
            mappedOptId = optId;
            break;
          }
        }

        // Skip if the mapped optimistic ID has a pending delete
        if (mappedOptId && pendingDeletes.has(mappedOptId)) {
          continue;
        }

        // Apply any pending updates
        let finalItem = item;
        const pendingUpdate = pendingUpdates.get(item.id);
        if (pendingUpdate) {
          finalItem = { ...item, ...pendingUpdate };
        }
        if (mappedOptId) {
          const optPendingUpdate = pendingUpdates.get(mappedOptId);
          if (optPendingUpdate) {
            finalItem = { ...finalItem, ...optPendingUpdate };
          }
        }

        cache.set(item.id, finalItem);
      }

      // Restore optimistic items that don't have server equivalents yet
      for (const [optId, item] of optimisticItems) {
        // Check if this optimistic ID has been mapped to a server ID
        const serverId = idMappings.get(optId);
        if (serverId && cache.has(serverId)) {
          // Server item exists, don't add optimistic version
          continue;
        }
        // Skip if pending delete
        if (pendingDeletes.has(optId)) {
          continue;
        }
        cache.set(optId, item);
      }

      status = "live";
      error = null;
      notify();
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        callbacks?.onAuthError?.();
        return;
      }
      error = err as Error;
      status = "error";
      notify();
    }
  };

  const init = async () => {
    await refresh();
    if (destroyed) return;

    // Subscribe to the whole filter scope (skipExisting avoids re-receiving the
    // page we just fetched). We deliberately do NOT cap tracking to the loaded
    // ids: that id-window is unsound for pagination — it can't tell whether a
    // row belongs in the visible range, and would miss live changes to rows on
    // later pages and inserts that fall into the range. Tracking the full scope
    // lets the subscription mode decide what to render (e.g. strict applies
    // changes to rows it holds and defers the rest), and rows loaded later via
    // loadMore receive live updates without any window bookkeeping.
    const subscribeOptions: SubscribeOptions = {
      skipExisting: true,
    };
    if (options.filter) subscribeOptions.filter = options.filter;
    if (options.include) subscribeOptions.include = options.include;

    subscription = repo.subscribe(subscribeOptions, subscriptionCallbacks);
    await updatePendingCount();
  };

  init();

  // Network status handlers - works in browser, can be overridden for React Native
  let cleanupNetworkListeners: (() => void) | undefined;

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const handleOnline = () => {
      if (status === "offline" || status === "reconnecting") {
        status = subscription ? "reconnecting" : "offline";
        subscription?.reconnect();
        notify();
      }
    };

    const handleOffline = () => {
      status = "offline";
      notify();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    cleanupNetworkListeners = () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }

  const loadMore = async () => {
    if (destroyed || !hasMore || isLoadingMore || !nextCursor) return;

    isLoadingMore = true;
    notify();

    try {
      const listOptions: ListOptions = {
        cursor: nextCursor,
      };
      if (options.filter) listOptions.filter = options.filter;
      if (options.include) listOptions.include = options.include;
      if (options.orderBy) listOptions.orderBy = options.orderBy;
      if (options.limit) listOptions.limit = options.limit;
      if (options.select) listOptions.select = options.select;

      const result = await repo.list(listOptions);

      // Update pagination state
      hasMore = result.hasMore;
      nextCursor = result.nextCursor;

      // Add new items to cache (they're additions, not replacements)
      for (const item of result.items) {
        if (!pendingDeletes.has(item.id)) {
          let finalItem = item;

          // Apply pending local updates (from mutate.update)
          const pendingUpdate = pendingUpdates.get(item.id);
          if (pendingUpdate) {
            finalItem = { ...finalItem, ...pendingUpdate };
          }

          // Apply pending remote changes (from handleChange during loadMore)
          // This handles the race condition where a change event arrives while loadMore is in progress
          const pendingRemoteChange = pendingRemoteChanges.get(item.id);
          if (pendingRemoteChange) {
            finalItem = pendingRemoteChange;
            pendingRemoteChanges.delete(item.id);
          }

          cache.set(item.id, finalItem);
        }
      }

      isLoadingMore = false;
      notify();
    } catch (err) {
      isLoadingMore = false;
      if ((err as { status?: number }).status === 401) {
        callbacks?.onAuthError?.();
        return;
      }
      error = err as Error;
      notify();
    }
  };

  const mutate: LiveQueryMutations<T> = {
    create: (data) => {
      const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const optimisticItem = { ...data, id: optimisticId } as T;

      optimisticIds.add(optimisticId);
      cache.set(optimisticId, optimisticItem);
      bumpTotal(1);
      notify();

      repo.create(data, { optimisticId }).then((created) => {
        // Reconcile off the create response. With an offline manager, repo.create
        // resolves to the optimistic stand-in (id === optimisticId) and the real
        // reconciliation arrives via the SSE "added" event's optimisticId meta —
        // skip here. Without one, it resolves to the real server row but sends no
        // optimisticId header, so the SSE event carries no meta; reconcile here so
        // the optimistic entry is replaced instead of left as a duplicate.
        const serverId = (created as T | undefined)?.id;
        if (serverId && serverId !== optimisticId) {
          handleAdd(created as T, { optimisticId });
        }
        updatePendingCount();
      });

      return optimisticId;
    },

    update: (id, data) => {
      const existing = cache.get(id);
      if (existing) {
        const updated = { ...existing, ...data };

        // Detect stale relations: if a foreign key is being changed, clear the corresponding relation
        // e.g., if categoryId is changing from "cat-1" to "cat-2", clear "category"
        for (const key of Object.keys(data)) {
          if (key.endsWith("Id") && key.length > 2) {
            const relationKey = key.slice(0, -2); // categoryId -> category
            const oldFkValue = (existing as Record<string, unknown>)[key];
            const newFkValue = (data as Record<string, unknown>)[key];
            // Check if this foreign key changed
            if (oldFkValue !== newFkValue) {
              // Foreign key changed - clear the relation unless new data includes it
              if (!(relationKey in data)) {
                delete (updated as Record<string, unknown>)[relationKey];
              }
            }
          }
        }

        cache.set(id, updated);
        notify();
      }

      // Track pending update so it can be reapplied after reconnection
      // It will be cleared when we receive the "changed" event from server
      const existingPending = pendingUpdates.get(id) || {};
      pendingUpdates.set(id, { ...existingPending, ...data } as Partial<T>);

      repo.update(id, data).then(() => {
        updatePendingCount();
      });
    },

    delete: (id) => {
      if (cache.has(id)) bumpTotal(-1);
      cache.delete(id);
      optimisticIds.delete(id);
      // Track pending delete so item doesn't reappear on reconnection
      // It will be cleared when we receive the "removed" event from server
      pendingDeletes.add(id);
      notify();

      repo.delete(id).then(() => {
        updatePendingCount();
      });
    },
  };

  return {
    getSnapshot: () => cachedSnapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    mutate,
    refresh,
    loadMore,

    destroy: () => {
      destroyed = true;
      subscription?.unsubscribe();
      listeners.clear();
      cache.clear();
      cleanupNetworkListeners?.();
    },
  };
};

export const statusLabel = (status: LiveQueryStatus, pendingCount: number): string => {
  switch (status) {
    case "loading":
      return "Loading...";
    case "live":
      return "Live";
    case "reconnecting":
      return "Reconnecting...";
    case "offline":
      return pendingCount > 0 ? `Offline (${pendingCount} pending)` : "Offline";
    case "error":
      return "Error";
  }
};
