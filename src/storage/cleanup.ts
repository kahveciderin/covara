import type { StorageAdapter } from "./types";
import { getStorageKV, resetStorageKVFallback } from "./kv";
import { listAllObjects } from "./list";
import {
  deleteUploadSession,
  discardUploadArtifacts,
  isUploadSessionLive,
  listExpiredUploadSessionIds,
  loadUploadSession,
} from "./upload-sessions";
import { defineTask } from "@/tasks/define";
import type { TaskDefinition } from "@/tasks/types";
import { getLogger } from "@/server/logger";

export interface FileReference {
  id: string;
  status: string;
}

export interface FileResourceRegistration {
  resource: string;
  storage: StorageAdapter;
  keyPrefix: string;
  partsPrefix: string;
  findReferences(key: string): Promise<FileReference[]>;
  findStaleUploads(cutoff: Date): Promise<{ id: string; storagePath: string }[]>;
  deleteRow(id: string): Promise<void>;
}

export interface BlobDeletion {
  id: string;
  resource: string;
  key: string;
  phase: "prepared" | "ready";
  attempts: number;
  enqueuedAt: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface BlobDeletionConfig {
  maxAttempts?: number;
  backoffBaseMs?: number;
  batchSize?: number;
}

export interface BlobDeletionDrainResult {
  processed: number;
  deleted: number;
  dropped: number;
  failed: number;
  dead: number;
  skipped: number;
}

export interface SweepOptions {
  resource?: string;
  graceMs?: number;
  pendingUploadTtlMs?: number;
  now?: number;
  dryRun?: boolean;
}

export interface SweepResult {
  scanned: number;
  orphansDeleted: string[];
  pendingRowsDeleted: number;
  sessionsExpired: number;
  unlistable: number;
  errors: number;
}

const DELETIONS_HASH = "covara:storage:blobdel";
const DELETIONS_PENDING = "covara:storage:blobdel:pending";
const DELETIONS_DEAD = "covara:storage:blobdel:dead";
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const PREPARED_GRACE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const registry = new Map<string, FileResourceRegistration>();

export const registerFileResource = (registration: FileResourceRegistration): void => {
  registry.set(registration.resource, registration);
};

export const getFileResourceRegistration = (resource: string): FileResourceRegistration | undefined =>
  registry.get(resource);

export const resetStorageMaintenanceState = (): void => {
  registry.clear();
  resetStorageKVFallback();
};

const backoffMs = (attempts: number, base: number): number =>
  Math.min(base * 2 ** Math.min(attempts, 10), 5 * 60 * 1000);

const deletionId = (resource: string, key: string): string => `${resource}:${key}`;

const isLiveReference = (ref: FileReference): boolean => ref.status !== "rejected";

const writeDeletion = async (entry: BlobDeletion): Promise<void> => {
  const kv = getStorageKV();
  await kv.hset(DELETIONS_HASH, entry.id, JSON.stringify(entry));
  await kv.sadd(DELETIONS_PENDING, entry.id);
};

const clearDeletion = async (id: string): Promise<void> => {
  const kv = getStorageKV();
  await kv.srem(DELETIONS_PENDING, id);
  await kv.hdel(DELETIONS_HASH, id);
};

export const enqueueBlobDeletion = async (
  resource: string,
  key: string,
  options: { phase?: "prepared" | "ready"; now?: number } = {}
): Promise<BlobDeletion> => {
  const now = options.now ?? Date.now();
  const phase = options.phase ?? "ready";
  const entry: BlobDeletion = {
    id: deletionId(resource, key),
    resource,
    key,
    phase,
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: phase === "prepared" ? now + PREPARED_GRACE_MS : now,
  };
  await writeDeletion(entry);
  return entry;
};

const recordFailure = async (
  entry: BlobDeletion,
  error: unknown,
  now: number,
  config: BlobDeletionConfig
): Promise<"failed" | "dead"> => {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const base = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const message = error instanceof Error ? error.message : String(error);
  const next: BlobDeletion = { ...entry, phase: "ready", attempts: entry.attempts + 1, lastError: message };
  if (next.attempts >= maxAttempts) {
    const kv = getStorageKV();
    await kv.hset(DELETIONS_HASH, next.id, JSON.stringify(next));
    await kv.srem(DELETIONS_PENDING, next.id);
    await kv.sadd(DELETIONS_DEAD, next.id);
    getLogger().error("Blob deletion exhausted retries (parked in dead set)", {
      resource: next.resource,
      key: next.key,
      attempts: next.attempts,
      error: message,
    });
    return "dead";
  }
  next.nextAttemptAt = now + backoffMs(next.attempts, base);
  await writeDeletion(next);
  return "failed";
};

export const settleBlobDeletion = async (
  resource: string,
  key: string,
  config: BlobDeletionConfig = {}
): Promise<"deleted" | "deferred" | "failed"> => {
  const registration = registry.get(resource);
  const now = Date.now();
  const id = deletionId(resource, key);
  const existing = await getStorageKV().hget(DELETIONS_HASH, id);
  const entry: BlobDeletion = existing
    ? { ...(JSON.parse(existing) as BlobDeletion), phase: "ready" }
    : { id, resource, key, phase: "ready", attempts: 0, enqueuedAt: now, nextAttemptAt: now };

  if (!registration) {
    await writeDeletion({ ...entry, nextAttemptAt: now });
    return "deferred";
  }

  try {
    const refs = await registration.findReferences(key);
    if (refs.some(isLiveReference)) {
      await writeDeletion({ ...entry, nextAttemptAt: now + PREPARED_GRACE_MS });
      return "deferred";
    }
    await registration.storage.delete(key);
    await clearDeletion(id);
    return "deleted";
  } catch (error) {
    await recordFailure(entry, error, now, config);
    return "failed";
  }
};

export const drainBlobDeletions = async (
  config: BlobDeletionConfig = {},
  now: number = Date.now()
): Promise<BlobDeletionDrainResult> => {
  const result: BlobDeletionDrainResult = { processed: 0, deleted: 0, dropped: 0, failed: 0, dead: 0, skipped: 0 };
  const kv = getStorageKV();
  const ids = (await kv.smembers(DELETIONS_PENDING)).slice(0, config.batchSize ?? 100);

  for (const id of ids) {
    const raw = await kv.hget(DELETIONS_HASH, id);
    if (!raw) {
      await kv.srem(DELETIONS_PENDING, id);
      continue;
    }
    const entry = JSON.parse(raw) as BlobDeletion;
    if (entry.nextAttemptAt > now) continue;
    const registration = registry.get(entry.resource);
    if (!registration) {
      result.skipped++;
      continue;
    }

    result.processed++;
    try {
      const refs = await registration.findReferences(entry.key);
      if (refs.some(isLiveReference)) {
        await clearDeletion(id);
        result.dropped++;
        continue;
      }
      await registration.storage.delete(entry.key);
      await clearDeletion(id);
      result.deleted++;
    } catch (error) {
      const outcome = await recordFailure(entry, error, now, config);
      result[outcome]++;
    }
  }

  return result;
};

export const getBlobDeletionStats = async (): Promise<{ pending: number; dead: number }> => {
  const kv = getStorageKV();
  const [pending, dead] = await Promise.all([kv.scard(DELETIONS_PENDING), kv.scard(DELETIONS_DEAD)]);
  return { pending, dead };
};

const coveringPrefixes = (prefixes: string[]): string[] => {
  const unique = Array.from(new Set(prefixes)).sort((a, b) => a.length - b.length);
  return unique.filter((p, i) => !unique.slice(0, i).some((q) => p.startsWith(q)));
};

const expireSessions = async (
  options: SweepOptions,
  now: number,
  result: SweepResult
): Promise<void> => {
  for (const id of await listExpiredUploadSessionIds(now)) {
    const state = await loadUploadSession(id);
    if (!state) {
      if (!options.dryRun) await deleteUploadSession(id);
      continue;
    }
    if (options.resource && state.session.resource !== options.resource) continue;
    const registration = registry.get(state.session.resource);
    if (!registration) continue;
    result.sessionsExpired++;
    if (options.dryRun) continue;
    try {
      await discardUploadArtifacts(state, registration.storage);
      await deleteUploadSession(id);
    } catch (error) {
      result.errors++;
      getLogger().warn("Failed to clean up expired upload session", {
        uploadId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const removeStaleUploads = async (
  registrations: FileResourceRegistration[],
  options: SweepOptions,
  now: number,
  result: SweepResult
): Promise<void> => {
  const cutoff = new Date(now - (options.pendingUploadTtlMs ?? DAY_MS));
  for (const registration of registrations) {
    for (const row of await registration.findStaleUploads(cutoff)) {
      result.pendingRowsDeleted++;
      if (options.dryRun) continue;
      try {
        await registration.storage.delete(row.storagePath);
        await registration.deleteRow(row.id);
      } catch {
        result.errors++;
      }
    }
  }
};

const sessionIdFromPartKey = (key: string, partsPrefix: string): string | null => {
  if (!key.startsWith(partsPrefix)) return null;
  const rest = key.slice(partsPrefix.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
};

const scanOrphans = async (
  registrations: FileResourceRegistration[],
  options: SweepOptions,
  now: number,
  result: SweepResult
): Promise<void> => {
  const byStorage = new Map<StorageAdapter, FileResourceRegistration[]>();
  for (const registration of registry.values()) {
    const group = byStorage.get(registration.storage) ?? [];
    group.push(registration);
    byStorage.set(registration.storage, group);
  }
  const graceCutoff = now - (options.graceMs ?? DAY_MS);

  for (const [storage, group] of byStorage) {
    const targets = group.filter((r) => registrations.includes(r));
    if (targets.length === 0) continue;
    if (typeof storage.list !== "function") {
      result.unlistable++;
      continue;
    }
    for (const prefix of coveringPrefixes(targets.map((r) => r.keyPrefix))) {
      for await (const object of listAllObjects(storage, prefix)) {
        result.scanned++;
        if (object.lastModified.getTime() > graceCutoff) continue;
        try {
          const owner = group.find((r) => sessionIdFromPartKey(object.key, r.partsPrefix) !== null);
          if (owner) {
            const sessionId = sessionIdFromPartKey(object.key, owner.partsPrefix)!;
            if (await isUploadSessionLive(sessionId, now)) continue;
          } else {
            let referenced = false;
            for (const registration of group) {
              if ((await registration.findReferences(object.key)).some(isLiveReference)) {
                referenced = true;
                break;
              }
            }
            if (referenced) continue;
          }
          result.orphansDeleted.push(object.key);
          if (!options.dryRun) await storage.delete(object.key);
        } catch {
          result.errors++;
        }
      }
    }
  }
};

export const sweepOrphanedBlobs = async (options: SweepOptions = {}): Promise<SweepResult> => {
  const now = options.now ?? Date.now();
  const result: SweepResult = {
    scanned: 0,
    orphansDeleted: [],
    pendingRowsDeleted: 0,
    sessionsExpired: 0,
    unlistable: 0,
    errors: 0,
  };
  const registrations = Array.from(registry.values()).filter(
    (r) => !options.resource || r.resource === options.resource
  );

  await expireSessions(options, now, result);
  await removeStaleUploads(registrations, options, now, result);
  await scanOrphans(registrations, options, now, result);
  return result;
};

export interface StorageMaintenanceOptions extends SweepOptions, BlobDeletionConfig {}

export const runStorageMaintenance = async (
  options: StorageMaintenanceOptions = {}
): Promise<{ deletions: BlobDeletionDrainResult; sweep: SweepResult }> => {
  const deletions = await drainBlobDeletions(options, options.now ?? Date.now());
  const sweep = await sweepOrphanedBlobs(options);
  return { deletions, sweep };
};

let drainHandle: ReturnType<typeof setInterval> | null = null;
let sweepHandle: ReturnType<typeof setInterval> | null = null;

const unref = (handle: ReturnType<typeof setInterval>): void => {
  (handle as { unref?: () => void }).unref?.();
};

export const stopStorageMaintenance = (): void => {
  if (drainHandle) clearInterval(drainHandle);
  if (sweepHandle) clearInterval(sweepHandle);
  drainHandle = null;
  sweepHandle = null;
};

export const startStorageMaintenance = (
  options: Omit<StorageMaintenanceOptions, "now"> & { drainIntervalMs?: number; sweepIntervalMs?: number } = {}
): (() => void) => {
  if (drainHandle || sweepHandle) return stopStorageMaintenance;
  const report = (label: string) => (error: unknown) =>
    getLogger().warn(`Storage maintenance ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  drainHandle = setInterval(() => {
    void drainBlobDeletions(options).catch(report("drain"));
  }, options.drainIntervalMs ?? 30_000);
  sweepHandle = setInterval(() => {
    void sweepOrphanedBlobs(options).catch(report("sweep"));
  }, options.sweepIntervalMs ?? 60 * 60 * 1000);
  unref(drainHandle);
  unref(sweepHandle);
  return stopStorageMaintenance;
};

export const defineStorageMaintenanceTask = (
  options: Omit<StorageMaintenanceOptions, "now"> & { name?: string } = {}
): TaskDefinition<unknown, { deletions: BlobDeletionDrainResult; sweep: SweepResult }> =>
  defineTask({
    name: options.name ?? "covara.storage.maintenance",
    handler: async () => runStorageMaintenance(options),
  });
