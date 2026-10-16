import type { StorageAdapter } from "./types";
import { getStorageKV } from "./kv";

export type UploadSessionStatus = "active" | "completing" | "completed" | "failed";

export interface UploadSession {
  id: string;
  resource: string;
  key: string;
  filename: string;
  declaredType: string | null;
  size: number;
  partSize: number;
  partCount: number;
  checksum?: { algorithm: "sha256"; value: string };
  ownerId: string | null;
  tokenHash: string | null;
  mode: "native" | "fallback";
  nativeUploadId?: string;
  direct: boolean;
  partsPrefix: string;
  fileId: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredPart {
  size: number;
  etag: string;
}

export interface UploadSessionState {
  session: UploadSession;
  status: UploadSessionStatus;
  parts: Map<number, StoredPart>;
  sniffedType?: string;
}

const SESSION_PREFIX = "covara:uploads:s:";
const LOCK_PREFIX = "covara:uploads:lock:";
const EXPIRY_INDEX = "covara:uploads:expiry";
const RETENTION_SECONDS = 24 * 60 * 60;

const sessionKey = (id: string): string => `${SESSION_PREFIX}${id}`;

export const uploadPartKey = (session: Pick<UploadSession, "partsPrefix" | "id">, partNumber: number): string =>
  `${session.partsPrefix}${session.id}/${partNumber}`;

export const createUploadSession = async (session: UploadSession): Promise<void> => {
  const kv = getStorageKV();
  const key = sessionKey(session.id);
  await kv.hmset(key, { session: JSON.stringify(session), status: "active" });
  await kv.expire(key, Math.ceil((session.expiresAt - Date.now()) / 1000) + RETENTION_SECONDS);
  await kv.zadd(EXPIRY_INDEX, session.expiresAt, session.id);
};

export const loadUploadSession = async (id: string): Promise<UploadSessionState | null> => {
  const fields = await getStorageKV().hgetall(sessionKey(id));
  if (!fields || !fields.session) return null;
  const parts = new Map<number, StoredPart>();
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith("p:")) continue;
    parts.set(Number(field.slice(2)), JSON.parse(value) as StoredPart);
  }
  return {
    session: JSON.parse(fields.session) as UploadSession,
    status: (fields.status as UploadSessionStatus) ?? "active",
    parts,
    sniffedType: fields.sniff || undefined,
  };
};

export const setUploadSessionStatus = async (id: string, status: UploadSessionStatus): Promise<void> => {
  await getStorageKV().hset(sessionKey(id), "status", status);
};

export const recordUploadPart = async (id: string, partNumber: number, part: StoredPart): Promise<void> => {
  await getStorageKV().hset(sessionKey(id), `p:${partNumber}`, JSON.stringify(part));
};

export const forgetUploadPart = async (id: string, partNumber: number): Promise<void> => {
  await getStorageKV().hdel(sessionKey(id), `p:${partNumber}`);
};

export const recordSniffedType =async (id: string, mimeType: string): Promise<void> => {
  await getStorageKV().hset(sessionKey(id), "sniff", mimeType);
};

export const deleteUploadSession = async (id: string): Promise<void> => {
  const kv = getStorageKV();
  await kv.del(sessionKey(id), `${LOCK_PREFIX}${id}`);
  await kv.zrem(EXPIRY_INDEX, id);
};

export const acquireCompletionLock = async (id: string, ttlSeconds = 120): Promise<boolean> => {
  const kv = getStorageKV();
  const key = `${LOCK_PREFIX}${id}`;
  const holders = await kv.incr(key);
  if (holders === 1 || (await kv.ttl(key)) < 0) {
    await kv.expire(key, ttlSeconds);
  }
  return holders === 1;
};

export const releaseCompletionLock = async (id: string): Promise<void> => {
  await getStorageKV().del(`${LOCK_PREFIX}${id}`);
};

export const listExpiredUploadSessionIds = async (now: number): Promise<string[]> =>
  getStorageKV().zrangebyscore(EXPIRY_INDEX, "-inf", now);

export const isUploadSessionLive = async (id: string, now: number): Promise<boolean> => {
  const state = await loadUploadSession(id);
  if (!state) return false;
  return state.session.expiresAt > now && (state.status === "active" || state.status === "completing");
};

export const discardUploadArtifacts = async (
  state: UploadSessionState,
  storage: StorageAdapter
): Promise<void> => {
  const { session } = state;
  if (state.status === "completed") return;
  if (session.mode === "native" && session.nativeUploadId && storage.abortMultipartUpload) {
    await storage.abortMultipartUpload(session.key, session.nativeUploadId);
    return;
  }
  if (session.mode === "fallback" && session.partCount > 0) {
    const keys = Array.from({ length: session.partCount }, (_, i) => uploadPartKey(session, i + 1));
    await storage.deleteMany(keys);
  }
};
