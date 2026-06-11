import { KVAdapter } from "@/kv/types";

const COMPLETED_PREFIX = "concave:tasks:idempotency:completed:";

export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CompletedMarker {
  taskId: string;
  result: unknown;
  completedAt: number;
}

export interface IdempotencyStore {
  getCompleted(key: string): Promise<CompletedMarker | null>;
  markCompleted(
    key: string,
    marker: CompletedMarker,
    retentionMs: number
  ): Promise<void>;
}

export const createIdempotencyStore = (kv: KVAdapter): IdempotencyStore => ({
  async getCompleted(key: string): Promise<CompletedMarker | null> {
    const raw = await kv.get(`${COMPLETED_PREFIX}${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CompletedMarker;
    } catch {
      return null;
    }
  },

  async markCompleted(
    key: string,
    marker: CompletedMarker,
    retentionMs: number
  ): Promise<void> {
    await kv.set(`${COMPLETED_PREFIX}${key}`, JSON.stringify(marker), {
      ex: Math.max(1, Math.ceil(retentionMs / 1000)),
    });
  },
});
