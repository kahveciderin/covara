export { KVSessionStore, createKVSessionStore } from "./kv";
export type { KVSessionStoreOptions } from "./kv";

// Deprecated aliases — the KV session store works with any KV adapter, not only Redis.
export { RedisSessionStore, createRedisSessionStore } from "./kv";
export type { RedisSessionStoreOptions } from "./kv";

export {
  DrizzleSessionStore,
  createDrizzleSessionStore,
} from "./drizzle";
export type { DrizzleSessionStoreOptions, SessionsTableColumns } from "./drizzle";

export { InMemorySessionStore } from "../types";
