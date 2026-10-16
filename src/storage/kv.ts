import { getGlobalKV, hasGlobalKV, type KVAdapter } from "@/kv/types";
import { MemoryKVStore } from "@/kv/memory";

let fallback: MemoryKVStore | null = null;

export const getStorageKV = (): KVAdapter => {
  if (hasGlobalKV()) return getGlobalKV();
  fallback ??= new MemoryKVStore();
  return fallback;
};

export const isStorageKVDurable = (): boolean => hasGlobalKV();

export const resetStorageKVFallback = (): void => {
  fallback = null;
};
