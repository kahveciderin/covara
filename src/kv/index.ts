/**
 * KV Store Module
 *
 * Provides a Redis-compatible key-value store abstraction that can be backed by
 * either an in-memory store (for development) or Redis (for production).
 *
 * Usage:
 *
 * ```typescript
 * import { createKV, setGlobalKV, getGlobalKV } from 'covara';
 *
 * // Initialize once at app startup
 * const kv = await createKV({ type: 'memory' }); // or 'redis'
 * setGlobalKV(kv);
 *
 * // Use anywhere in your app
 * const kv = getGlobalKV();
 * await kv.set('key', 'value');
 * ```
 */

export type {
  KVAdapter,
  KVTransaction,
  KVConfig,
  RedisConfig,
  DurableObjectConfig,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  SetOptions,
  ZRangeOptions,
  ScanOptions,
  ScanResult,
} from "./types";

export { setGlobalKV, getGlobalKV, hasGlobalKV, clearGlobalKV } from "./types";

export { MemoryKVStore, createMemoryKV } from "./memory";

export { RedisKVStore, createRedisKV, createRedisKVFromConfig } from "./redis";

export {
  CovaraKVDurableObject,
  DurableKVEngine,
  DurableObjectKVStore,
  createDurableObjectKV,
} from "./durable-object";
export type {
  DurableObjectKVOptions,
  DurableObjectStateLike,
  DurableObjectStorageLike,
  WebSocketLike,
} from "./durable-object";

import { KVAdapter, KVConfig, setGlobalKV } from "./types";
import { createMemoryKV } from "./memory";
import { createRedisKVFromConfig } from "./redis";
import { createDurableObjectKV } from "./durable-object";

/**
 * Create a KV adapter based on configuration
 *
 * @param config - Configuration specifying the KV store type and settings
 * @returns A KV adapter instance
 *
 * @example
 * // In-memory store (for development)
 * const kv = await createKV({ type: 'memory', prefix: 'myapp' });
 *
 * @example
 * // Redis store (for production)
 * const kv = await createKV({
 *   type: 'redis',
 *   prefix: 'myapp',
 *   redis: { url: 'redis://localhost:6379' }
 * });
 */
export const createKV = async (config: KVConfig): Promise<KVAdapter> => {
  let kv: KVAdapter;

  if (config.type === "redis") {
    if (!config.redis) {
      throw new Error("Redis configuration required when type is 'redis'");
    }
    kv = await createRedisKVFromConfig(config.redis, config.prefix);
  } else if (config.type === "durable-object") {
    if (!config.durableObject?.namespace) {
      throw new Error(
        "Durable Object namespace required when type is 'durable-object'"
      );
    }
    kv = createDurableObjectKV(config.durableObject.namespace, {
      name: config.durableObject.name,
      prefix: config.prefix,
    });
  } else {
    kv = createMemoryKV(config.prefix);
  }

  await kv.connect();
  return kv;
};

/**
 * Create and set the global KV adapter
 *
 * Convenience function that creates a KV adapter and sets it as the global instance.
 *
 * @param config - Configuration specifying the KV store type and settings
 * @returns The created KV adapter instance
 */
export const initializeKV = async (config: KVConfig): Promise<KVAdapter> => {
  const kv = await createKV(config);
  setGlobalKV(kv);

  // Auto-wire cross-process subscription fan-out for distributed stores so
  // multi-instance deployments deliver each other's realtime events without a
  // manual init call. Dynamic import avoids a static kv -> resource cycle.
  if (config.type !== "memory") {
    try {
      const { initializeEventSubscription } = await import("@/resource/subscription");
      await initializeEventSubscription();
    } catch {
      // Subscription fan-out is best-effort at init; resource module may be
      // tree-shaken out in deployments that don't use subscriptions.
    }
  }

  return kv;
};
