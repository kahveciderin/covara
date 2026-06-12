import { ChangelogEntry } from "./types";
import { getGlobalKV, hasGlobalKV, KVAdapter } from "../kv";

// KV keys
const CHANGELOG_SEQ_KEY = "covara:changelog:seq";
const CHANGELOG_ENTRIES_KEY = "covara:changelog:entries";

export interface ChangelogConfig {
  maxEntries?: number;
  onEntryAdded?: (entry: ChangelogEntry) => void;
}

const getKV = (): KVAdapter | null => {
  return hasGlobalKV() ? getGlobalKV() : null;
};

class ChangelogManager {
  // Local fallback state (used when KV is not available)
  private localSequence = 0;
  private localEntries: ChangelogEntry[] = [];
  private maxEntries: number;
  private onEntryAdded?: (entry: ChangelogEntry) => void;

  constructor(config: ChangelogConfig = {}) {
    this.maxEntries = config.maxEntries ?? 10000;
    this.onEntryAdded = config.onEntryAdded;
  }

  async append(entry: Omit<ChangelogEntry, "seq">): Promise<ChangelogEntry> {
    const kv = getKV();

    let seq: number;
    if (kv) {
      // Use atomic increment in KV store
      seq = await kv.incr(CHANGELOG_SEQ_KEY);

      const fullEntry: ChangelogEntry = {
        ...entry,
        seq,
      };

      // Store entry in sorted set with seq as score
      await kv.zadd(CHANGELOG_ENTRIES_KEY, seq, JSON.stringify(fullEntry));

      // Trim old entries if needed
      const count = await kv.zcard(CHANGELOG_ENTRIES_KEY);
      if (count > this.maxEntries) {
        // Remove oldest entries (lowest scores)
        const excess = count - this.maxEntries;
        const oldEntries = await kv.zrange(CHANGELOG_ENTRIES_KEY, 0, excess - 1);
        if (oldEntries.length > 0) {
          await kv.zrem(CHANGELOG_ENTRIES_KEY, ...oldEntries);
        }
      }

      if (this.onEntryAdded) {
        this.onEntryAdded(fullEntry);
      }

      return fullEntry;
    } else {
      // Fallback to local state
      this.localSequence++;
      seq = this.localSequence;

      const fullEntry: ChangelogEntry = {
        ...entry,
        seq,
      };

      this.localEntries.push(fullEntry);

      if (this.localEntries.length > this.maxEntries) {
        const excess = this.localEntries.length - this.maxEntries;
        this.localEntries.splice(0, excess);
      }

      if (this.onEntryAdded) {
        this.onEntryAdded(fullEntry);
      }

      return fullEntry;
    }
  }

  // Synchronous version for backwards compatibility
  appendSync(entry: Omit<ChangelogEntry, "seq">): ChangelogEntry {
    // For sync operations, we can only use local state
    // This is provided for backwards compatibility but async should be preferred
    this.localSequence++;
    const seq = this.localSequence;

    const fullEntry: ChangelogEntry = {
      ...entry,
      seq,
    };

    this.localEntries.push(fullEntry);

    if (this.localEntries.length > this.maxEntries) {
      const excess = this.localEntries.length - this.maxEntries;
      this.localEntries.splice(0, excess);
    }

    if (this.onEntryAdded) {
      this.onEntryAdded(fullEntry);
    }

    return fullEntry;
  }

  async getEntriesSince(resource: string, sinceSeq: number): Promise<ChangelogEntry[]> {
    const kv = getKV();

    if (kv) {
      // Get entries with seq > sinceSeq
      const entries = await kv.zrangebyscore(
        CHANGELOG_ENTRIES_KEY,
        sinceSeq + 1, // exclusive lower bound
        "+inf"
      );

      return entries
        .map((data) => JSON.parse(data) as ChangelogEntry)
        .filter((entry) => entry.resource === resource);
    } else {
      return this.localEntries.filter(
        (entry) => entry.resource === resource && entry.seq > sinceSeq
      );
    }
  }

  async getAllEntriesSince(sinceSeq: number): Promise<ChangelogEntry[]> {
    const kv = getKV();

    if (kv) {
      const entries = await kv.zrangebyscore(
        CHANGELOG_ENTRIES_KEY,
        sinceSeq + 1,
        "+inf"
      );

      return entries.map((data) => JSON.parse(data) as ChangelogEntry);
    } else {
      return this.localEntries.filter((entry) => entry.seq > sinceSeq);
    }
  }

  async getEntriesForResources(
    resources: string[],
    sinceSeq: number
  ): Promise<ChangelogEntry[]> {
    const resourceSet = new Set(resources);
    const kv = getKV();

    if (kv) {
      const entries = await kv.zrangebyscore(
        CHANGELOG_ENTRIES_KEY,
        sinceSeq + 1,
        "+inf"
      );

      return entries
        .map((data) => JSON.parse(data) as ChangelogEntry)
        .filter((entry) => resourceSet.has(entry.resource));
    } else {
      return this.localEntries.filter(
        (entry) => resourceSet.has(entry.resource) && entry.seq > sinceSeq
      );
    }
  }

  async getCurrentSequence(): Promise<number> {
    const kv = getKV();

    if (kv) {
      const seq = await kv.get(CHANGELOG_SEQ_KEY);
      return seq ? parseInt(seq, 10) : 0;
    } else {
      return this.localSequence;
    }
  }

  // Synchronous version for backwards compatibility
  getCurrentSequenceSync(): number {
    return this.localSequence;
  }

  async getMinAvailableSequence(): Promise<number> {
    const kv = getKV();

    if (kv) {
      const entries = await kv.zrange(CHANGELOG_ENTRIES_KEY, 0, 0);
      if (entries.length === 0) {
        return await this.getCurrentSequence();
      }
      const oldest = JSON.parse(entries[0]) as ChangelogEntry;
      return oldest.seq;
    } else {
      if (this.localEntries.length === 0) return this.localSequence;
      return this.localEntries[0].seq;
    }
  }

  async hasEntriesSince(sinceSeq: number): Promise<boolean> {
    const currentSeq = await this.getCurrentSequence();
    const minSeq = await this.getMinAvailableSequence();
    return sinceSeq < currentSeq && sinceSeq >= minSeq;
  }

  async needsInvalidation(sinceSeq: number): Promise<boolean> {
    if (sinceSeq <= 0) return false;
    const minSeq = await this.getMinAvailableSequence();
    return sinceSeq < minSeq;
  }

  // Synchronous version for backwards compatibility
  needsInvalidationSync(sinceSeq: number): boolean {
    if (sinceSeq <= 0) return false;
    if (this.localEntries.length === 0) return sinceSeq < this.localSequence;
    return sinceSeq < this.localEntries[0].seq;
  }

  async clear(): Promise<void> {
    const kv = getKV();

    if (kv) {
      await kv.del(CHANGELOG_SEQ_KEY, CHANGELOG_ENTRIES_KEY);
    }

    this.localEntries = [];
    this.localSequence = 0;
  }

  async getEntryCount(): Promise<number> {
    const kv = getKV();

    if (kv) {
      return kv.zcard(CHANGELOG_ENTRIES_KEY);
    } else {
      return this.localEntries.length;
    }
  }

  async getRecentEntries(limit: number): Promise<ChangelogEntry[]> {
    const kv = getKV();

    if (kv) {
      // Get all entries and take the most recent ones
      const count = await kv.zcard(CHANGELOG_ENTRIES_KEY);
      const start = Math.max(0, count - limit);
      const entries = await kv.zrange(CHANGELOG_ENTRIES_KEY, start, count - 1);
      return entries
        .map((data: string) => JSON.parse(data) as ChangelogEntry)
        .reverse();
    } else {
      // Return the last 'limit' entries
      return this.localEntries.slice(-limit).reverse();
    }
  }

  async getEntriesInRange(fromSeq: number, limit: number): Promise<ChangelogEntry[]> {
    const kv = getKV();

    if (kv) {
      const entries = await kv.zrangebyscore(
        CHANGELOG_ENTRIES_KEY,
        fromSeq,
        "+inf"
      );
      return entries
        .slice(0, limit)
        .map((data) => JSON.parse(data) as ChangelogEntry);
    } else {
      return this.localEntries
        .filter((entry) => entry.seq >= fromSeq)
        .slice(0, limit);
    }
  }
}

export const changelog = new ChangelogManager();

export const recordCreate = async (
  resource: string,
  objectId: string,
  object: Record<string, unknown>,
  userId?: string
): Promise<ChangelogEntry> => {
  return changelog.append({
    resource,
    type: "create",
    objectId,
    object,
    timestamp: Date.now(),
    userId,
  });
};

export const recordUpdate = async (
  resource: string,
  objectId: string,
  object: Record<string, unknown>,
  previousObject?: Record<string, unknown>,
  userId?: string
): Promise<ChangelogEntry> => {
  return changelog.append({
    resource,
    type: "update",
    objectId,
    object,
    previousObject,
    timestamp: Date.now(),
    userId,
  });
};

export const recordDelete = async (
  resource: string,
  objectId: string,
  previousObject?: Record<string, unknown>,
  userId?: string
): Promise<ChangelogEntry> => {
  return changelog.append({
    resource,
    type: "delete",
    objectId,
    previousObject,
    timestamp: Date.now(),
    userId,
  });
};

export { ChangelogManager };

export const createResourceChangelog = (
  resource: string,
  parentChangelog: ChangelogManager = changelog
) => {
  return {
    recordCreate: (objectId: string, object: Record<string, unknown>) =>
      parentChangelog.append({
        resource,
        type: "create",
        objectId,
        object,
        timestamp: Date.now(),
      }),
    recordUpdate: (
      objectId: string,
      object: Record<string, unknown>,
      previousObject?: Record<string, unknown>
    ) =>
      parentChangelog.append({
        resource,
        type: "update",
        objectId,
        object,
        previousObject,
        timestamp: Date.now(),
      }),
    recordDelete: (objectId: string, previousObject?: Record<string, unknown>) =>
      parentChangelog.append({
        resource,
        type: "delete",
        objectId,
        previousObject,
        timestamp: Date.now(),
      }),
    getEntriesSince: (sinceSeq: number) =>
      parentChangelog.getEntriesSince(resource, sinceSeq),
    getCurrentSequence: () => parentChangelog.getCurrentSequence(),
    needsInvalidation: (sinceSeq: number) =>
      parentChangelog.needsInvalidation(sinceSeq),
  };
};
