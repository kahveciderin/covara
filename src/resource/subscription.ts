import { v4 as uuidv4 } from "uuid";
import { SSEWriter } from "@/server/sse";
import { Filter, CompiledFilterExpression } from "./filter";
import { changelog } from "./changelog";
import {
  Subscription,
  SubscriptionEvent,
  AddedEvent,
  ChangedEvent,
  RemovedEvent,
  InvalidateEvent,
  ExistingEvent,
  ChangelogEntry,
} from "./types";
import { getGlobalKV, hasGlobalKV, KVAdapter } from "../kv";

// Local process state (cannot be shared across processes)
// HTTP handlers must stay in memory on the process that owns the connection
const localHandlers = new Map<string, SSEWriter>();

// Backpressure policy per local handler: what to do when a client's outbound
// buffer is full (slow consumer). "invalidate" forces a refetch+resume,
// "disconnect" drops the connection, "drop" silently skips the event.
export type BackpressurePolicy = "invalidate" | "disconnect" | "drop";
const localHandlerPolicies = new Map<string, BackpressurePolicy>();

// Per-resource field-read masking. The resource hook registers a masker that
// strips non-readable table columns; we apply it to every outgoing event object
// AFTER filter matching (so masked columns can still be used in subscription
// filters) and BEFORE the payload reaches the client.
const resourceMaskers = new Map<string, (item: Record<string, unknown>) => Record<string, unknown>>();

export const registerResourceMask = (
  resource: string,
  mask: (item: Record<string, unknown>) => Record<string, unknown>
): void => {
  resourceMaskers.set(resource, mask);
};

const maskForResource = <T extends Record<string, unknown>>(resource: string, item: T): T => {
  const mask = resourceMaskers.get(resource);
  return mask ? (mask(item) as T) : item;
};

// Local cache for compiled filters (each process can have its own cache)
const compiledFiltersCache = new Map<string, CompiledFilterExpression>();

// Track which handler IDs are local to this process
const localHandlerIds = new Set<string>();

// Aggregate subscriptions don't track individual rows — they recompute when
// anything on the resource changes. Watchers are local to the process that owns
// the SSE connection; cross-process mutations reach them via AGGREGATE_CHANNEL.
//
// The watcher receives the raw changed rows (when the mutation path has them)
// so it can skip recompute when none of them fall in its scope/filter — this is
// what keeps a per-user aggregate from recomputing on every other user's
// mutation. `changed` is undefined when row data isn't available (deletes, raw
// SQL, cross-process notifications), in which case the watcher must recompute
// conservatively.
type AggregateWatcher = (changed?: Record<string, unknown>[]) => void;
const aggregateWatchers = new Map<string, Set<AggregateWatcher>>();

// In-memory fallback storage (used when KV is not configured)
const localSubscriptions = new Map<string, Subscription>();
const localRelevantObjects = new Map<string, Set<string>>();
const localSeqCounters = new Map<string, number>();
const localSubsByResource = new Map<string, Set<string>>();

// Last event delivery time per subscription (process-local, best effort) for
// the admin UI's "Last Event" column.
const localEventTimestamps = new Map<string, number>();

// SSE handlers are strictly process-local, so every subscription created for a
// handler is known to this process. Tracking handler → subscription IDs here
// lets disconnect cleanup run in O(own subscriptions) without scanning KV.
const localHandlerSubs = new Map<string, Set<string>>();
const localSubHandlers = new Map<string, string>();

const trackHandlerSubscription = (handlerId: string, subscriptionId: string): void => {
  let subs = localHandlerSubs.get(handlerId);
  if (!subs) {
    subs = new Set();
    localHandlerSubs.set(handlerId, subs);
  }
  subs.add(subscriptionId);
  localSubHandlers.set(subscriptionId, handlerId);
};

const untrackSubscription = (subscriptionId: string): void => {
  const handlerId = localSubHandlers.get(subscriptionId);
  if (handlerId === undefined) return;
  localSubHandlers.delete(subscriptionId);
  const subs = localHandlerSubs.get(handlerId);
  if (subs) {
    subs.delete(subscriptionId);
    if (subs.size === 0) localHandlerSubs.delete(handlerId);
  }
};

// KV keys
// Subscriptions are sharded into one hash per resource so a mutation only ever
// loads the subscriptions of the resource it touched — never the whole fleet.
// A small set of resource names (the index) lets cold paths (stats, admin
// listing, clearAll) enumerate the shards.
const SUBSCRIPTIONS_BY_RESOURCE_PREFIX = "covara:subs:byres:";
const SUBSCRIPTIONS_RESOURCE_INDEX = "covara:subs:resources";

const subscriptionHashKey = (resource: string): string =>
  `${SUBSCRIPTIONS_BY_RESOURCE_PREFIX}${resource}`;

// The resource is embedded in the subscription ID (`<uuid>:<resource>`) so
// ID-only operations (get/remove/updateSeq) can address the right shard
// without a secondary lookup. UUIDs are exactly 36 chars and contain no colon.
const resourceFromSubscriptionId = (subscriptionId: string): string | null =>
  subscriptionId.length > 37 && subscriptionId[36] === ":"
    ? subscriptionId.slice(37)
    : null;
const SUBSCRIPTION_OBJECTS_PREFIX = "covara:sub:objects:";
const SUBSCRIPTION_SEQ_PREFIX = "covara:sub:seq:";
const EVENTS_CHANNEL = "covara:events";
const AGGREGATE_CHANNEL = "covara:aggregate";

interface SerializedSubscription {
  id: string;
  createdAt: string;
  resource: string;
  filter: string;
  authId: string | null;
  handlerId: string;
  lastSeq: number;
  scopeFilter?: string;
  authExpiresAt?: string | null;
  include?: string;
}

interface BroadcastEvent {
  type: "added" | "changed" | "removed" | "invalidate";
  subscriptionId: string;
  event: SubscriptionEvent;
}

const serializeSubscription = (sub: Subscription): string => {
  const serialized: SerializedSubscription = {
    id: sub.id,
    createdAt: sub.createdAt.toISOString(),
    resource: sub.resource,
    filter: sub.filter,
    authId: sub.authId,
    handlerId: sub.handlerId,
    lastSeq: sub.lastSeq,
    scopeFilter: sub.scopeFilter,
    authExpiresAt: sub.authExpiresAt?.toISOString() ?? null,
    include: sub.include,
  };
  return JSON.stringify(serialized);
};

const deserializeSubscription = (data: string): Subscription => {
  const parsed: SerializedSubscription = JSON.parse(data);
  return {
    id: parsed.id,
    createdAt: new Date(parsed.createdAt),
    resource: parsed.resource,
    filter: parsed.filter,
    authId: parsed.authId,
    handlerId: parsed.handlerId,
    relevantObjectIds: new Set(), // Will be loaded separately
    lastSeq: parsed.lastSeq,
    scopeFilter: parsed.scopeFilter,
    authExpiresAt: parsed.authExpiresAt ? new Date(parsed.authExpiresAt) : null,
    include: parsed.include,
  };
};

const getKV = (): KVAdapter | null => {
  return hasGlobalKV() ? getGlobalKV() : null;
};

// Register a callback invoked whenever the given resource is mutated, for
// aggregate subscriptions to recompute. Returns an unsubscribe function.
export const registerAggregateWatcher = (
  resource: string,
  watcher: AggregateWatcher
): (() => void) => {
  let set = aggregateWatchers.get(resource);
  if (!set) {
    set = new Set();
    aggregateWatchers.set(resource, set);
  }
  set.add(watcher);
  return () => {
    const current = aggregateWatchers.get(resource);
    if (!current) return;
    current.delete(watcher);
    if (current.size === 0) aggregateWatchers.delete(resource);
  };
};

const notifyLocalAggregateWatchers = (
  resource: string,
  changed?: Record<string, unknown>[]
): void => {
  const set = aggregateWatchers.get(resource);
  if (!set) return;
  for (const watcher of set) {
    try {
      watcher(changed);
    } catch {
      // a failing watcher must not break mutation processing
    }
  }
};

// Signal that a resource was mutated so aggregate subscriptions recompute.
// Notifies local watchers immediately (with the changed rows, when available,
// so watchers can skip recompute for out-of-scope mutations) and (when KV is
// configured) publishes to other processes. The cross-process notification
// carries no row data — remote watchers recompute conservatively — to avoid
// shipping raw rows over pub/sub. Double-delivery to the publisher is harmless;
// watchers debounce before recomputing.
export const notifyAggregateWatchers = async (
  resource: string,
  changed?: Record<string, unknown>[]
): Promise<void> => {
  if (aggregateWatchers.size > 0) {
    notifyLocalAggregateWatchers(resource, changed);
  }
  const kv = getKV();
  if (kv) {
    await kv.publish(AGGREGATE_CHANNEL, JSON.stringify({ resource }));
  }
};

export const getAggregateWatcherCount = (resource?: string): number => {
  if (resource) return aggregateWatchers.get(resource)?.size ?? 0;
  let total = 0;
  for (const set of aggregateWatchers.values()) total += set.size;
  return total;
};

// Load relevant object IDs from KV or local storage
const loadRelevantObjects = async (subscriptionId: string): Promise<Set<string>> => {
  const kv = getKV();
  if (kv) {
    const members = await kv.smembers(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`);
    return new Set(members);
  }
  return localRelevantObjects.get(subscriptionId) ?? new Set();
};

// Save a relevant object ID to KV or local storage (exported for testing)
export const addRelevantObject = async (subscriptionId: string, objectId: string): Promise<void> => {
  const kv = getKV();
  if (kv) {
    await kv.sadd(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`, objectId);
    return;
  }
  let objects = localRelevantObjects.get(subscriptionId);
  if (!objects) {
    objects = new Set();
    localRelevantObjects.set(subscriptionId, objects);
  }
  objects.add(objectId);
};

// Register multiple known IDs at once (for skipExisting mode)
export const registerKnownIds = async (subscriptionId: string, ids: string[]): Promise<void> => {
  if (ids.length === 0) return;

  const kv = getKV();
  if (kv) {
    await kv.sadd(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`, ...ids);
    return;
  }

  let objects = localRelevantObjects.get(subscriptionId);
  if (!objects) {
    objects = new Set();
    localRelevantObjects.set(subscriptionId, objects);
  }
  for (const id of ids) {
    objects.add(id);
  }
};

// Remove a relevant object ID from KV or local storage
const removeRelevantObject = async (subscriptionId: string, objectId: string): Promise<void> => {
  const kv = getKV();
  if (kv) {
    await kv.srem(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`, objectId);
    return;
  }
  const objects = localRelevantObjects.get(subscriptionId);
  if (objects) objects.delete(objectId);
};

// Check if an object is relevant to a subscription
const isObjectRelevant = async (subscriptionId: string, objectId: string): Promise<boolean> => {
  const kv = getKV();
  if (kv) {
    return kv.sismember(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`, objectId);
  }
  const objects = localRelevantObjects.get(subscriptionId);
  return objects?.has(objectId) ?? false;
};

export interface CreateSubscriptionOptions {
  resource: string;
  filter: string;
  handlerId: string;
  authId: string | null;
  scopeFilter?: string;
  authExpiresAt?: Date | null;
  include?: string;
}

export const createSubscription = async (
  options: CreateSubscriptionOptions
): Promise<string> => {
  const subscriptionId = `${uuidv4()}:${options.resource}`;
  const subscription: Subscription = {
    id: subscriptionId,
    createdAt: new Date(),
    resource: options.resource,
    filter: options.filter,
    authId: options.authId,
    handlerId: options.handlerId,
    relevantObjectIds: new Set(),
    lastSeq: await changelog.getCurrentSequence(),
    scopeFilter: options.scopeFilter,
    authExpiresAt: options.authExpiresAt,
    include: options.include,
  };

  const kv = getKV();
  if (kv) {
    await kv.hset(
      subscriptionHashKey(options.resource),
      subscriptionId,
      serializeSubscription(subscription)
    );
    await kv.sadd(SUBSCRIPTIONS_RESOURCE_INDEX, options.resource);
    await kv.set(`${SUBSCRIPTION_SEQ_PREFIX}${subscriptionId}`, "0");
  } else {
    // Store in local memory
    localSubscriptions.set(subscriptionId, subscription);
    localSeqCounters.set(subscriptionId, 0);
    let byResource = localSubsByResource.get(options.resource);
    if (!byResource) {
      byResource = new Set();
      localSubsByResource.set(options.resource, byResource);
    }
    byResource.add(subscriptionId);
  }

  trackHandlerSubscription(options.handlerId, subscriptionId);

  return subscriptionId;
};

export const removeSubscription = async (subscriptionId: string): Promise<void> => {
  compiledFiltersCache.delete(subscriptionId);
  untrackSubscription(subscriptionId);
  localEventTimestamps.delete(subscriptionId);

  const kv = getKV();
  if (kv) {
    const resource = resourceFromSubscriptionId(subscriptionId);
    if (resource) {
      await kv.hdel(subscriptionHashKey(resource), subscriptionId);
    } else {
      // Unknown ID format: clear it from every shard (cold fallback).
      const resources = await kv.smembers(SUBSCRIPTIONS_RESOURCE_INDEX);
      for (const res of resources) {
        await kv.hdel(subscriptionHashKey(res), subscriptionId);
      }
    }
    await kv.del(
      `${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`,
      `${SUBSCRIPTION_SEQ_PREFIX}${subscriptionId}`
    );
  } else {
    const sub = localSubscriptions.get(subscriptionId);
    if (sub) {
      const byResource = localSubsByResource.get(sub.resource);
      if (byResource) {
        byResource.delete(subscriptionId);
        if (byResource.size === 0) localSubsByResource.delete(sub.resource);
      }
    }
    localSubscriptions.delete(subscriptionId);
    localRelevantObjects.delete(subscriptionId);
    localSeqCounters.delete(subscriptionId);
  }
};

export const getSubscription = async (subscriptionId: string): Promise<Subscription | undefined> => {
  const kv = getKV();
  if (kv) {
    const resource = resourceFromSubscriptionId(subscriptionId);
    let data: string | null = null;
    if (resource) {
      data = await kv.hget(subscriptionHashKey(resource), subscriptionId);
    } else {
      // Unknown ID format: check every shard (cold fallback).
      const resources = await kv.smembers(SUBSCRIPTIONS_RESOURCE_INDEX);
      for (const res of resources) {
        data = await kv.hget(subscriptionHashKey(res), subscriptionId);
        if (data) break;
      }
    }
    if (!data) return undefined;
    const subscription = deserializeSubscription(data);
    subscription.relevantObjectIds = await loadRelevantObjects(subscriptionId);
    return subscription;
  }

  const subscription = localSubscriptions.get(subscriptionId);
  if (subscription) {
    subscription.relevantObjectIds = await loadRelevantObjects(subscriptionId);
  }
  return subscription;
};

export const registerHandler = (
  handlerId: string,
  writer: SSEWriter,
  backpressurePolicy: BackpressurePolicy = "invalidate"
): void => {
  localHandlers.set(handlerId, writer);
  localHandlerIds.add(handlerId);
  localHandlerPolicies.set(handlerId, backpressurePolicy);
};

export const unregisterHandler = async (handlerId: string): Promise<void> => {
  localHandlers.delete(handlerId);
  localHandlerIds.delete(handlerId);
  localHandlerPolicies.delete(handlerId);

  // Handlers are process-local, so their subscriptions were created here and
  // are tracked locally — disconnect cleanup is O(own subscriptions), no scan.
  const tracked = localHandlerSubs.get(handlerId);
  if (tracked) {
    for (const subId of Array.from(tracked)) {
      await removeSubscription(subId);
    }
    return;
  }

  // Untracked handler (e.g. cleanup of subscriptions created by a previous
  // process incarnation): fall back to scanning every shard.
  const allSubs = await getAllSubscriptions();
  for (const [subId, sub] of allSubs) {
    if (sub.handlerId === handlerId) {
      await removeSubscription(subId);
    }
  }
};

const getNextSeq = async (subscriptionId: string): Promise<number> => {
  localEventTimestamps.set(subscriptionId, Date.now());
  const kv = getKV();
  if (kv) {
    return kv.incr(`${SUBSCRIPTION_SEQ_PREFIX}${subscriptionId}`);
  }
  const current = localSeqCounters.get(subscriptionId) ?? 0;
  const next = current + 1;
  localSeqCounters.set(subscriptionId, next);
  return next;
};

// Load one resource's subscriptions. This is the hot-path accessor used by the
// mutation push functions — cost scales with that resource's subscriber count,
// not the total subscription count.
const getSubscriptionsForResourceMap = async (
  resource: string
): Promise<Map<string, Subscription>> => {
  const kv = getKV();
  if (kv) {
    const result = new Map<string, Subscription>();
    const subs = await kv.hgetall(subscriptionHashKey(resource));
    for (const [subId, data] of Object.entries(subs)) {
      result.set(subId, deserializeSubscription(data));
    }
    return result;
  }

  const result = new Map<string, Subscription>();
  const ids = localSubsByResource.get(resource);
  if (!ids) return result;
  for (const id of ids) {
    const sub = localSubscriptions.get(id);
    if (sub) result.set(id, sub);
  }
  return result;
};

// Enumerate every shard. Cold paths only (stats, admin listing, fallback
// cleanup) — never called per mutation.
const getAllSubscriptions = async (): Promise<Map<string, Subscription>> => {
  const kv = getKV();
  if (kv) {
    const result = new Map<string, Subscription>();
    const resources = await kv.smembers(SUBSCRIPTIONS_RESOURCE_INDEX);
    for (const resource of resources) {
      const subs = await kv.hgetall(subscriptionHashKey(resource));
      for (const [subId, data] of Object.entries(subs)) {
        result.set(subId, deserializeSubscription(data));
      }
    }
    return result;
  }
  return new Map(localSubscriptions);
};

const getCompiledFilter = (
  subscription: Subscription,
  filterFactory: Filter
): CompiledFilterExpression => {
  const cacheKey = subscription.id;
  let compiled = compiledFiltersCache.get(cacheKey);

  if (!compiled) {
    let filterExpr = subscription.filter;
    if (subscription.scopeFilter) {
      filterExpr = filterExpr
        ? `(${filterExpr});(${subscription.scopeFilter})`
        : subscription.scopeFilter;
    }
    compiled = filterFactory.compile(filterExpr);
    compiledFiltersCache.set(cacheKey, compiled);
  }

  return compiled;
};

const sendEvent = <T extends SubscriptionEvent>(
  handlerId: string,
  event: T
): boolean => {
  // Only send if handler is local to this process
  if (!localHandlerIds.has(handlerId)) {
    return false;
  }

  const handler = localHandlers.get(handlerId);
  if (!handler || handler.closed) {
    return false;
  }

  // Slow-consumer handling: if the client's outbound buffer is already full,
  // do not keep enqueuing (which would grow memory unboundedly). Apply the
  // configured backpressure policy. With "invalidate"/"disconnect" the client
  // reconnects and the changelog catchup redelivers anything it missed, so no
  // event is silently lost within the changelog window.
  if (handler.backpressured) {
    const policy = localHandlerPolicies.get(handlerId) ?? "invalidate";
    if (policy === "drop") {
      return false;
    }
    if (policy === "invalidate") {
      try {
        handler.write(
          `data: ${JSON.stringify({ type: "invalidate", reason: "slow-consumer" })}\n\n`
        );
      } catch {
        // best effort — buffer may already be full
      }
    }
    handler.close();
    return false;
  }

  try {
    handler.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
};

// Broadcast event to all processes via pub/sub
const broadcastEvent = async (event: BroadcastEvent): Promise<void> => {
  const kv = getKV();
  if (!kv) return;

  await kv.publish(EVENTS_CHANNEL, JSON.stringify(event));
};

let eventSubscriptionInitialized = false;

// Initialize cross-process event fan-out for this process. Idempotent: safe to
// call multiple times (only the first call subscribes). Auto-invoked by
// initializeKV() so multi-instance deployments receive each other's events
// without the developer remembering a manual wiring step.
export const initializeEventSubscription = async (): Promise<void> => {
  const kv = getKV();
  if (!kv) return;
  if (eventSubscriptionInitialized) return;
  eventSubscriptionInitialized = true;

  await kv.subscribe(EVENTS_CHANNEL, async (message: string) => {
    try {
      const broadcast: BroadcastEvent = JSON.parse(message);
      const subscription = await getSubscription(broadcast.subscriptionId);
      if (!subscription) return;

      // Only process if this handler is local
      if (localHandlerIds.has(subscription.handlerId)) {
        sendEvent(subscription.handlerId, broadcast.event);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  // Fan out cross-process mutation signals to local aggregate watchers.
  await kv.subscribe(AGGREGATE_CHANNEL, (message: string) => {
    try {
      const { resource } = JSON.parse(message) as { resource?: string };
      if (typeof resource === "string") {
        notifyLocalAggregateWatchers(resource);
      }
    } catch {
      // Ignore malformed messages
    }
  });
};

export const sendExistingItems = async <T extends Record<string, unknown>>(
  subscriptionId: string,
  items: T[],
  idColumn: string
): Promise<void> => {
  const subscription = await getSubscription(subscriptionId);
  if (!subscription) return;

  for (const item of items) {
    const id = String(item[idColumn]);
    await addRelevantObject(subscriptionId, id);

    const event: ExistingEvent<T> = {
      id: uuidv4(),
      subscriptionId,
      seq: await getNextSeq(subscriptionId),
      timestamp: Date.now(),
      type: "existing",
      object: maskForResource(subscription.resource, item),
    };

    // Send directly if local, otherwise broadcast
    if (localHandlerIds.has(subscription.handlerId)) {
      sendEvent(subscription.handlerId, event);
    } else {
      await broadcastEvent({ type: "added", subscriptionId, event });
    }
  }
};

export type RelationLoader<T> = (items: T[], include: string) => Promise<T[]>;

export const pushInsertsToSubscriptions = async <T extends Record<string, unknown>>(
  resource: string,
  filterFactory: Filter,
  items: T[],
  idColumn: string,
  optimisticIds?: Map<string, string>,
  relationLoader?: RelationLoader<T>
): Promise<void> => {
  const allSubs = await getSubscriptionsForResourceMap(resource);

  // Cache for items with relations loaded (keyed by include string)
  const itemsWithRelationsCache = new Map<string, Map<string, T>>();

  const getItemWithRelations = async (item: T, include: string | undefined): Promise<T> => {
    if (!include || !relationLoader) return item;

    const id = String(item[idColumn]);
    let cache = itemsWithRelationsCache.get(include);
    if (!cache) {
      cache = new Map();
      itemsWithRelationsCache.set(include, cache);
    }

    if (cache.has(id)) {
      return cache.get(id)!;
    }

    // Load relations for this item
    const [itemWithRelations] = await relationLoader([item], include);
    cache.set(id, itemWithRelations);
    return itemWithRelations;
  };

  for (const [subId, subscription] of allSubs) {
    if (subscription.resource !== resource) continue;

    if (
      subscription.authExpiresAt &&
      subscription.authExpiresAt < new Date()
    ) {
      await sendInvalidateEvent(subId, "Authentication expired");
      continue;
    }

    const compiled = getCompiledFilter(subscription, filterFactory);

    for (const item of items) {
      const matches = compiled.execute(item);
      if (!matches) continue;

      const id = String(item[idColumn]);
      await addRelevantObject(subId, id);

      const optimisticId = optimisticIds?.get(id);
      const itemToSend = await getItemWithRelations(item, subscription.include);
      const event: AddedEvent<T> = {
        id: uuidv4(),
        subscriptionId: subId,
        seq: await getNextSeq(subId),
        timestamp: Date.now(),
        type: "added",
        object: maskForResource(resource, itemToSend),
        ...(optimisticId && { meta: { optimisticId } }),
      };

      // Try local first, then broadcast
      if (!sendEvent(subscription.handlerId, event)) {
        await broadcastEvent({ type: "added", subscriptionId: subId, event });
      }
    }
  }

  await notifyAggregateWatchers(resource, items as Record<string, unknown>[]);
};

export const pushUpdatesToSubscriptions = async <T extends Record<string, unknown>>(
  resource: string,
  filterFactory: Filter,
  items: T[],
  idColumn: string,
  previousItems?: Map<string, T>,
  relationLoader?: RelationLoader<T>
): Promise<void> => {
  const allSubs = await getSubscriptionsForResourceMap(resource);

  // Cache for items with relations loaded (keyed by include string)
  const itemsWithRelationsCache = new Map<string, Map<string, T>>();

  const getItemWithRelations = async (item: T, include: string | undefined): Promise<T> => {
    if (!include || !relationLoader) return item;

    const id = String(item[idColumn]);
    let cache = itemsWithRelationsCache.get(include);
    if (!cache) {
      cache = new Map();
      itemsWithRelationsCache.set(include, cache);
    }

    if (cache.has(id)) {
      return cache.get(id)!;
    }

    // Load relations for this item
    const [itemWithRelations] = await relationLoader([item], include);
    cache.set(id, itemWithRelations);
    return itemWithRelations;
  };

  for (const [subId, subscription] of allSubs) {
    if (subscription.resource !== resource) continue;

    if (
      subscription.authExpiresAt &&
      subscription.authExpiresAt < new Date()
    ) {
      await sendInvalidateEvent(subId, "Authentication expired");
      continue;
    }

    const compiled = getCompiledFilter(subscription, filterFactory);

    for (const item of items) {
      const id = String(item[idColumn]);
      const wasRelevant = await isObjectRelevant(subId, id);
      const isRelevant = compiled.execute(item);

      if (isRelevant && !wasRelevant) {
        await addRelevantObject(subId, id);

        const itemToSend = await getItemWithRelations(item, subscription.include);
        const event: AddedEvent<T> = {
          id: uuidv4(),
          subscriptionId: subId,
          seq: await getNextSeq(subId),
          timestamp: Date.now(),
          type: "added",
          object: maskForResource(resource, itemToSend),
        };

        if (!sendEvent(subscription.handlerId, event)) {
          await broadcastEvent({ type: "added", subscriptionId: subId, event });
        }
      } else if (isRelevant && wasRelevant) {
        const previousObjectId = previousItems?.get(id)
          ? String(previousItems.get(id)![idColumn])
          : undefined;

        const itemToSend = await getItemWithRelations(item, subscription.include);
        const event: ChangedEvent<T> = {
          id: uuidv4(),
          subscriptionId: subId,
          seq: await getNextSeq(subId),
          timestamp: Date.now(),
          type: "changed",
          object: maskForResource(resource, itemToSend),
          previousObjectId,
        };

        if (!sendEvent(subscription.handlerId, event)) {
          await broadcastEvent({ type: "changed", subscriptionId: subId, event });
        }
      } else if (!isRelevant && wasRelevant) {
        await removeRelevantObject(subId, id);

        const event: RemovedEvent = {
          id: uuidv4(),
          subscriptionId: subId,
          seq: await getNextSeq(subId),
          timestamp: Date.now(),
          type: "removed",
          objectId: id,
        };

        if (!sendEvent(subscription.handlerId, event)) {
          await broadcastEvent({ type: "removed", subscriptionId: subId, event });
        }
      }
    }
  }

  // Pass both new and previous state: an update can move a row into or out of a
  // filtered aggregate's scope, so a watcher must recompute if either matches.
  const changed: Record<string, unknown>[] = [...(items as Record<string, unknown>[])];
  if (previousItems) {
    for (const prev of previousItems.values()) changed.push(prev as Record<string, unknown>);
  }
  await notifyAggregateWatchers(resource, changed);
};

export const pushDeletesToSubscriptions = async (
  resource: string,
  deletedIds: string[],
  deletedObjects?: Record<string, unknown>[]
): Promise<void> => {
  const allSubs = await getSubscriptionsForResourceMap(resource);

  for (const [subId, subscription] of allSubs) {
    if (subscription.resource !== resource) continue;

    for (const id of deletedIds) {
      const wasRelevant = await isObjectRelevant(subId, id);
      if (!wasRelevant) continue;

      await removeRelevantObject(subId, id);

      const event: RemovedEvent = {
        id: uuidv4(),
        subscriptionId: subId,
        seq: await getNextSeq(subId),
        timestamp: Date.now(),
        type: "removed",
        objectId: id,
      };

      if (!sendEvent(subscription.handlerId, event)) {
        await broadcastEvent({ type: "removed", subscriptionId: subId, event });
      }
    }
  }

  // When the deleted rows' prior content is available, watchers can scope-skip:
  // a row that wasn't in a subscription's scope can't change its aggregate.
  // Without it (IDs only) every watcher must recompute conservatively.
  await notifyAggregateWatchers(resource, deletedObjects);
};

export const sendInvalidateEvent = async (
  subscriptionId: string,
  reason?: string
): Promise<void> => {
  const subscription = await getSubscription(subscriptionId);
  if (!subscription) return;

  const event: InvalidateEvent = {
    id: uuidv4(),
    subscriptionId,
    seq: await getNextSeq(subscriptionId),
    timestamp: Date.now(),
    type: "invalidate",
    reason,
  };

  if (!sendEvent(subscription.handlerId, event)) {
    await broadcastEvent({ type: "invalidate", subscriptionId, event });
  }
};

// Send an `invalidate` to every subscription on a resource, forcing clients to
// refetch. Used for mutations the framework can't observe row-by-row: raw SQL
// and writes from external processes (via recordExternalMutation).
export const invalidateResourceSubscriptions = async (
  resource: string,
  reason?: string
): Promise<void> => {
  const allSubs = await getSubscriptionsForResourceMap(resource);
  for (const subId of allSubs.keys()) {
    await sendInvalidateEvent(subId, reason);
  }

  await notifyAggregateWatchers(resource);
};

export const processChangelogEntries = async (
  entries: ChangelogEntry[],
  filterFactory: Filter,
  idColumn: string
): Promise<void> => {
  for (const entry of entries) {
    switch (entry.type) {
      case "create":
        if (entry.object) {
          await pushInsertsToSubscriptions(
            entry.resource,
            filterFactory,
            [entry.object],
            idColumn
          );
        }
        break;

      case "update":
        if (entry.object) {
          const previousMap = new Map<string, Record<string, unknown>>();
          if (entry.previousObject) {
            previousMap.set(entry.objectId, entry.previousObject);
          }
          await pushUpdatesToSubscriptions(
            entry.resource,
            filterFactory,
            [entry.object],
            idColumn,
            previousMap
          );
        }
        break;

      case "delete":
        await pushDeletesToSubscriptions(entry.resource, [entry.objectId]);
        break;
    }
  }
};

export const getSubscriptionsForResource = async (resource: string): Promise<Subscription[]> => {
  const kv = getKV();
  if (!kv) return [];

  const result: Subscription[] = [];
  const subs = await getSubscriptionsForResourceMap(resource);

  for (const subscription of subs.values()) {
    subscription.relevantObjectIds = await loadRelevantObjects(subscription.id);
    result.push(subscription);
  }

  return result;
};

export const updateSubscriptionSeq = async (
  subscriptionId: string,
  seq: number
): Promise<void> => {
  const kv = getKV();
  if (!kv) return;

  const resource = resourceFromSubscriptionId(subscriptionId);
  if (!resource) return;

  const hashKey = subscriptionHashKey(resource);
  const data = await kv.hget(hashKey, subscriptionId);
  if (!data) return;

  const subscription = deserializeSubscription(data);
  subscription.lastSeq = seq;
  await kv.hset(hashKey, subscriptionId, serializeSubscription(subscription));
};

export const getCatchupEvents = async (
  subscriptionId: string,
  sinceSeq: number
): Promise<ChangelogEntry[] | null> => {
  const subscription = await getSubscription(subscriptionId);
  if (!subscription) return null;

  if (await changelog.needsInvalidation(sinceSeq)) {
    return null;
  }

  return await changelog.getEntriesSince(subscription.resource, sinceSeq);
};

export const isHandlerConnected = (handlerId: string): boolean => {
  // Only check local handlers
  if (!localHandlerIds.has(handlerId)) {
    return false;
  }

  const handler = localHandlers.get(handlerId);
  return handler !== undefined && !handler.closed;
};

export const getHandlerSubscriptions = async (handlerId: string): Promise<string[]> => {
  const kv = getKV();
  if (!kv) return [];

  // Fast path: handlers are process-local, so their subscriptions are tracked.
  const tracked = localHandlerSubs.get(handlerId);
  if (tracked) return Array.from(tracked);

  const result: string[] = [];
  const allSubs = await getAllSubscriptions();

  for (const [id, sub] of allSubs) {
    if (sub.handlerId === handlerId) {
      result.push(id);
    }
  }

  return result;
};

export const clearRelevantObjects = async (subscriptionId: string): Promise<void> => {
  const kv = getKV();
  if (!kv) return;

  await kv.del(`${SUBSCRIPTION_OBJECTS_PREFIX}${subscriptionId}`);
};

export const invalidateFilterCache = (subscriptionId: string): void => {
  compiledFiltersCache.delete(subscriptionId);
};

export const getSubscriptionStats = async (): Promise<{
  totalSubscriptions: number;
  totalHandlers: number;
  subscriptionsByResource: Record<string, number>;
}> => {
  const kv = getKV();
  if (!kv) {
    return {
      totalSubscriptions: 0,
      totalHandlers: localHandlers.size,
      subscriptionsByResource: {},
    };
  }

  const subscriptionsByResource: Record<string, number> = {};
  const allSubs = await getAllSubscriptions();

  for (const sub of allSubs.values()) {
    subscriptionsByResource[sub.resource] =
      (subscriptionsByResource[sub.resource] ?? 0) + 1;
  }

  return {
    totalSubscriptions: allSubs.size,
    totalHandlers: localHandlers.size,
    subscriptionsByResource,
  };
};

// Gracefully close every SSE connection owned by this process. Used during
// shutdown draining so clients receive a clean stream end (and reconnect with
// resume) instead of a dropped socket.
export const closeAllHandlers = (): number => {
  let closed = 0;
  for (const writer of localHandlers.values()) {
    try {
      writer.close();
      closed++;
    } catch {
      // ignore writers already torn down
    }
  }
  return closed;
};

export const getActiveHandlerCount = (): number => localHandlers.size;

export interface ActiveSubscriptionInfo {
  id: string;
  resource: string;
  filter?: string;
  userId?: string;
  connectedAt: string;
  eventCount: number;
  lastEventAt?: string;
  connected: boolean;
}

// Snapshot of registered subscriptions (KV-backed or local), flagged by whether
// their SSE handler is connected to this process. Shaped for the admin UI's
// subscriptions view.
export const listActiveSubscriptions = async (): Promise<ActiveSubscriptionInfo[]> => {
  const all = await getAllSubscriptions();
  const kv = getKV();
  const result: ActiveSubscriptionInfo[] = [];
  for (const s of all.values()) {
    // The per-subscription seq counter increments once per delivered event, so
    // it doubles as the event count.
    let eventCount = 0;
    if (kv) {
      const raw = await kv.get(`${SUBSCRIPTION_SEQ_PREFIX}${s.id}`);
      eventCount = raw ? parseInt(raw, 10) || 0 : 0;
    } else {
      eventCount = localSeqCounters.get(s.id) ?? 0;
    }
    const lastEventAt = localEventTimestamps.get(s.id);
    result.push({
      id: s.id,
      resource: s.resource,
      filter: s.filter || undefined,
      userId: s.authId ?? undefined,
      connectedAt:
        s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt ?? ""),
      eventCount,
      lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : undefined,
      connected: localHandlerIds.has(s.handlerId),
    });
  }
  return result;
};

// Force-close a subscription from the admin UI. Closing the local SSE writer
// triggers the route's cleanup (handler unregister + record removal). When the
// connection lives on another process, invalidate it (so the client refetches)
// and drop the record so delivery stops.
export const disconnectSubscription = async (subscriptionId: string): Promise<boolean> => {
  const subscription = await getSubscription(subscriptionId);
  if (!subscription) return false;

  const handler = localHandlers.get(subscription.handlerId);
  if (handler) {
    handler.close();
    return true;
  }

  await sendInvalidateEvent(subscriptionId, "Disconnected by admin");
  await removeSubscription(subscriptionId);
  return true;
};

export const clearAllSubscriptions = async (): Promise<void> => {
  compiledFiltersCache.clear();
  localHandlers.clear();
  localHandlerIds.clear();
  localHandlerPolicies.clear();
  localHandlerSubs.clear();
  localSubHandlers.clear();
  localSubscriptions.clear();
  localRelevantObjects.clear();
  localSeqCounters.clear();
  localSubsByResource.clear();
  localEventTimestamps.clear();
  eventSubscriptionInitialized = false;

  const kv = getKV();
  if (!kv) return;

  // Enumerate every resource shard and clear it plus each subscription's
  // related keys, then drop the resource index itself.
  const resources = await kv.smembers(SUBSCRIPTIONS_RESOURCE_INDEX);
  const keysToDelete: string[] = [SUBSCRIPTIONS_RESOURCE_INDEX];

  for (const resource of resources) {
    const hashKey = subscriptionHashKey(resource);
    keysToDelete.push(hashKey);
    const subs = await kv.hgetall(hashKey);
    for (const subId of Object.keys(subs)) {
      keysToDelete.push(
        `${SUBSCRIPTION_OBJECTS_PREFIX}${subId}`,
        `${SUBSCRIPTION_SEQ_PREFIX}${subId}`
      );
    }
  }

  if (keysToDelete.length > 0) {
    await kv.del(...keysToDelete);
  }
};
