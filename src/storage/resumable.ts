import type { Context, Hono } from "hono";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { ConflictError, NotFoundError, ResourceError, ValidationError } from "@/resource/error";
import { getUser } from "@/server/context";
import { readJsonBody } from "@/server/request";
import { readBodyCapped } from "./http";
import { SNIFF_BYTES } from "./sniff";
import { readObjectHead, supportsMultipart, type MultipartPart, type StorageAdapter } from "./types";
import {
  acquireCompletionLock,
  createUploadSession,
  deleteUploadSession,
  discardUploadArtifacts,
  forgetUploadPart,
  loadUploadSession,
  recordSniffedType,
  recordUploadPart,
  releaseCompletionLock,
  setUploadSessionStatus,
  uploadPartKey,
  type StoredPart,
  type UploadSession,
  type UploadSessionState,
} from "./upload-sessions";

const MIB = 1024 * 1024;

export const UPLOAD_TOKEN_HEADER = "covara-upload-token";
export const PART_SHA256_HEADER = "covara-part-sha256";

export interface ResumableUploadConfig {
  partSize?: number;
  minPartSize?: number;
  maxPartSize?: number;
  maxParts?: number;
  sessionTtlSeconds?: number;
  maxSize?: number;
  direct?: boolean;
}

export interface PersistFileInput {
  id: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ResumableRouteDeps {
  storage: StorageAdapter;
  resource: string;
  partsPrefix: string;
  config: ResumableUploadConfig;
  maxSize?: number;
  presignedUrlExpiry: number;
  makeKey(filename: string, userId?: string): string;
  requireCreate(c: Context): Promise<void>;
  checkContent(declared: string | null, sample: Uint8Array, complete: boolean): string;
  persist(c: Context, input: PersistFileInput): Promise<Record<string, unknown>>;
  findFile(id: string): Promise<Record<string, unknown> | undefined>;
  mask(record: Record<string, unknown>): Record<string, unknown>;
}

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const uploadExpired = (): ResourceError =>
  new ResourceError("Upload session has expired", 410, "UPLOAD_EXPIRED");

const expectedPartSize = (session: UploadSession, partNumber: number): number =>
  partNumber < session.partCount ? session.partSize : session.size - (session.partCount - 1) * session.partSize;

const parsePartNumber = (raw: string, session: UploadSession): number => {
  if (!/^\d+$/.test(raw)) throw new ValidationError("Part number must be a positive integer");
  const n = Number(raw);
  if (n < 1 || n > session.partCount) {
    throw new ValidationError(`Part number must be between 1 and ${session.partCount}`, {
      partCount: session.partCount,
    });
  }
  return n;
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const missingParts = (session: UploadSession, parts: Map<number, StoredPart>): number[] => {
  const missing: number[] = [];
  for (let n = 1; n <= session.partCount; n++) if (!parts.has(n)) missing.push(n);
  return missing;
};

export const mountResumableUploadRoutes = (router: Hono, deps: ResumableRouteDeps): void => {
  const { storage, config } = deps;
  const native = supportsMultipart(storage);
  const canPresignParts =
    native &&
    config.direct !== false &&
    typeof storage.getUploadPartUrl === "function" &&
    typeof storage.listMultipartParts === "function";

  const planParts = (size: number, requested: unknown): { partSize: number; partCount: number } => {
    const adapterLimits = native ? storage.multipartLimits : undefined;
    const min = Math.max(config.minPartSize ?? 5 * MIB, adapterLimits?.minPartSize ?? 1);
    const max = Math.min(config.maxPartSize ?? 64 * MIB, adapterLimits?.maxPartSize ?? Infinity);
    const maxParts = Math.min(config.maxParts ?? 10000, adapterLimits?.maxParts ?? Infinity);
    const wanted = isPositiveInteger(requested) ? requested : config.partSize ?? 8 * MIB;
    let partSize = Math.min(Math.max(wanted, min), max);
    if (size === 0) return { partSize, partCount: 0 };
    if (Math.ceil(size / partSize) > maxParts) {
      partSize = Math.ceil(size / maxParts);
      if (partSize > max) {
        throw new ValidationError(
          `File too large for a resumable upload: ${size} bytes would exceed ${maxParts} parts of at most ${max} bytes`,
          { size, maxParts, maxPartSize: max }
        );
      }
    }
    return { partSize, partCount: Math.ceil(size / partSize) };
  };

  const loadOwned = async (c: Context, id: string): Promise<UploadSessionState> => {
    const state = await loadUploadSession(id);
    if (!state || state.session.resource !== deps.resource) throw new NotFoundError("Upload session", id);
    const { ownerId, tokenHash } = state.session;
    if (ownerId !== null) {
      if (getUser(c)?.id !== ownerId) throw new NotFoundError("Upload session", id);
      return state;
    }
    const token = c.req.header(UPLOAD_TOKEN_HEADER);
    const presented = token ? Buffer.from(sha256Hex(token), "hex") : Buffer.alloc(32);
    const expected = Buffer.from(tokenHash ?? "", "hex");
    if (!token || expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new NotFoundError("Upload session", id);
    }
    return state;
  };

  const assertActive = (state: UploadSessionState): void => {
    if (state.status === "completed" || state.status === "completing") {
      throw new ConflictError("Upload session is already completed", { status: state.status });
    }
    if (state.status === "failed") throw new ConflictError("Upload session has failed", { status: state.status });
    if (state.session.expiresAt <= Date.now()) throw uploadExpired();
  };

  const abortSession = async (state: UploadSessionState): Promise<void> => {
    await discardUploadArtifacts(state, storage);
    if (state.status === "completing" && !(await deps.findFile(state.session.fileId))) {
      await storage.delete(state.session.key).catch(() => undefined);
    }
    await deleteUploadSession(state.session.id);
  };

  const failSession = async (state: UploadSessionState): Promise<void> => {
    await storage.delete(state.session.key).catch(() => undefined);
    await discardUploadArtifacts({ ...state, status: "failed" }, storage).catch(() => undefined);
    await setUploadSessionStatus(state.session.id, "failed");
  };

  const collectParts = async (state: UploadSessionState): Promise<Map<number, StoredPart>> => {
    const { session } = state;
    if (!session.direct || !session.nativeUploadId || !storage.listMultipartParts) return state.parts;
    const listed = await storage.listMultipartParts(session.key, session.nativeUploadId);
    const parts = new Map(state.parts);
    for (const part of listed) {
      parts.set(part.partNumber, { size: part.size ?? parts.get(part.partNumber)?.size ?? 0, etag: part.etag });
    }
    return parts;
  };

  const describe = (state: UploadSessionState, parts: Map<number, StoredPart>) => {
    const sorted = [...parts.entries()].sort(([a], [b]) => a - b);
    return {
      uploadId: state.session.id,
      filename: state.session.filename,
      size: state.session.size,
      partSize: state.session.partSize,
      partCount: state.session.partCount,
      status: state.status,
      direct: state.session.direct,
      expiresAt: new Date(state.session.expiresAt).toISOString(),
      parts: sorted.map(([partNumber, part]) => ({ partNumber, size: part.size, etag: part.etag })),
      missingParts: missingParts(state.session, parts),
      receivedBytes: sorted.reduce((sum, [, part]) => sum + part.size, 0),
      mimeType: state.sniffedType ?? null,
      fileId: state.status === "completed" ? state.session.fileId : null,
    };
  };

  router.post("/uploads", async (c) => {
    await deps.requireCreate(c);
    const body = (await readJsonBody(c)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ValidationError("JSON body is required");

    const { filename, size, contentType, checksum } = body;
    if (typeof filename !== "string" || filename.length === 0 || filename.length > 1024) {
      throw new ValidationError("filename is required (1-1024 characters)");
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      throw new ValidationError("size must be a non-negative integer");
    }
    if (deps.maxSize !== undefined && size > deps.maxSize) {
      throw new ValidationError(`File too large. Maximum size: ${deps.maxSize} bytes`, {
        maxSize: deps.maxSize,
        size,
      });
    }
    if (contentType !== undefined && contentType !== null && typeof contentType !== "string") {
      throw new ValidationError("contentType must be a string");
    }
    let normalizedChecksum: UploadSession["checksum"];
    if (checksum !== undefined && checksum !== null) {
      const cs = checksum as { algorithm?: unknown; value?: unknown };
      if (cs.algorithm !== "sha256" || typeof cs.value !== "string" || !/^[0-9a-f]{64}$/i.test(cs.value)) {
        throw new ValidationError("checksum must be { algorithm: \"sha256\", value: <64 hex chars> }");
      }
      normalizedChecksum = { algorithm: "sha256", value: cs.value.toLowerCase() };
    }

    const { partSize, partCount } = planParts(size, body.partSize);
    const user = getUser(c);
    const ownerId = user?.id ?? null;
    const uploadToken = ownerId === null ? randomBytes(32).toString("base64url") : undefined;
    const key = deps.makeKey(filename, user?.id);
    const useNative = native && partCount > 0;
    const direct = body.direct === true && useNative && canPresignParts;
    const nativeUploadId = useNative
      ? (await storage.createMultipartUpload!(key, { filename, mimeType: "application/octet-stream" })).uploadId
      : undefined;

    const now = Date.now();
    const session: UploadSession = {
      id: randomUUID(),
      resource: deps.resource,
      key,
      filename,
      declaredType: typeof contentType === "string" && contentType ? contentType : null,
      size,
      partSize,
      partCount,
      checksum: normalizedChecksum,
      ownerId,
      tokenHash: uploadToken ? sha256Hex(uploadToken) : null,
      mode: useNative ? "native" : "fallback",
      nativeUploadId,
      direct,
      partsPrefix: deps.partsPrefix,
      fileId: randomUUID(),
      createdAt: now,
      expiresAt: now + (config.sessionTtlSeconds ?? 24 * 60 * 60) * 1000,
    };
    await createUploadSession(session);

    return c.json(
      {
        uploadId: session.id,
        ...(uploadToken ? { uploadToken } : {}),
        size,
        partSize,
        partCount,
        direct,
        status: "active",
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      201
    );
  });

  router.get("/uploads/:uploadId", async (c) => {
    const state = await loadOwned(c, c.req.param("uploadId"));
    if (state.status !== "completed" && state.session.expiresAt <= Date.now()) throw uploadExpired();
    const parts = state.status === "active" ? await collectParts(state) : state.parts;
    return c.json(describe(state, parts));
  });

  router.put("/uploads/:uploadId/parts/:partNumber", async (c) => {
    const state = await loadOwned(c, c.req.param("uploadId"));
    assertActive(state);
    const { session } = state;
    const partNumber = parsePartNumber(c.req.param("partNumber"), session);
    const expected = expectedPartSize(session, partNumber);
    const data = await readBodyCapped(c, expected);
    if (data.length !== expected) {
      throw new ValidationError(`Part ${partNumber} must be exactly ${expected} bytes (received ${data.length})`, {
        partNumber,
        expected,
        received: data.length,
      });
    }
    const declaredHash = c.req.header(PART_SHA256_HEADER);
    if (declaredHash && declaredHash.trim().toLowerCase() !== sha256Hex(data)) {
      throw new ValidationError(`Part ${partNumber} checksum mismatch`, { partNumber });
    }

    if (partNumber === 1) {
      let mimeType: string;
      try {
        mimeType = deps.checkContent(
          session.declaredType,
          data.subarray(0, SNIFF_BYTES),
          session.partCount === 1 && data.length <= SNIFF_BYTES
        );
      } catch (error) {
        await abortSession(state);
        throw error;
      }
      await recordSniffedType(session.id, mimeType);
    }

    let etag: string;
    if (session.mode === "native" && session.nativeUploadId) {
      etag = (await storage.uploadPart!(session.key, session.nativeUploadId, partNumber, data)).etag;
    } else {
      const result = await storage.upload(uploadPartKey(session, partNumber), data, {
        mimeType: "application/octet-stream",
      });
      etag = result.etag ?? sha256Hex(data);
    }
    await recordUploadPart(session.id, partNumber, { size: data.length, etag });
    return c.json({ partNumber, size: data.length, etag });
  });

  router.get("/uploads/:uploadId/parts/:partNumber/url", async (c) => {
    const state = await loadOwned(c, c.req.param("uploadId"));
    assertActive(state);
    const { session } = state;
    if (!session.direct || !session.nativeUploadId) {
      throw new ValidationError("This upload session does not support direct part uploads");
    }
    const partNumber = parsePartNumber(c.req.param("partNumber"), session);
    const expiresIn = Math.max(1, Math.min(deps.presignedUrlExpiry, Math.floor((session.expiresAt - Date.now()) / 1000)));
    const url = await storage.getUploadPartUrl!(session.key, session.nativeUploadId, partNumber, { expiresIn });
    if (!url) throw new ValidationError("Failed to generate a part upload URL");
    return c.json({
      partNumber,
      url,
      size: expectedPartSize(session, partNumber),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  });

  const assemble = async (state: UploadSessionState, parts: Map<number, StoredPart>): Promise<string | undefined> => {
    const { session } = state;
    if (session.partCount === 0) {
      await storage.upload(session.key, Buffer.alloc(0), { filename: session.filename, mimeType: "application/octet-stream" });
      return sha256Hex(new Uint8Array());
    }
    if (session.mode === "native" && session.nativeUploadId) {
      const list: MultipartPart[] = [...parts.entries()].map(([partNumber, part]) => ({
        partNumber,
        etag: part.etag,
        size: part.size,
      }));
      await storage.completeMultipartUpload!(session.key, session.nativeUploadId, list);
      return undefined;
    }
    const hash = createHash("sha256");
    async function* concatenate(): AsyncGenerator<Buffer> {
      for (let n = 1; n <= session.partCount; n++) {
        const chunk = await storage.download(uploadPartKey(session, n));
        hash.update(chunk);
        yield chunk;
      }
    }
    await storage.upload(session.key, Readable.from(concatenate()), {
      filename: session.filename,
      mimeType: "application/octet-stream",
    });
    return hash.digest("hex");
  };

  const digestObject = async (key: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of await storage.downloadStream(key)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  };

  router.post("/uploads/:uploadId/complete", async (c) => {
    const id = c.req.param("uploadId");
    const initial = await loadOwned(c, id);
    if (initial.status === "completed") {
      const file = await deps.findFile(initial.session.fileId);
      if (!file) throw new NotFoundError("File", initial.session.fileId);
      return c.json(deps.mask(file), 200);
    }
    if (initial.status === "failed") throw new ConflictError("Upload session has failed", { status: "failed" });
    if (initial.session.expiresAt <= Date.now()) throw uploadExpired();
    await deps.requireCreate(c);

    if (!(await acquireCompletionLock(id))) {
      throw new ConflictError("Upload completion is already in progress");
    }
    try {
      const state = await loadOwned(c, id);
      const { session } = state;
      if (state.status === "completed") {
        const file = await deps.findFile(session.fileId);
        if (file) return c.json(deps.mask(file), 200);
      }

      const existing = await deps.findFile(session.fileId);
      if (existing) {
        await setUploadSessionStatus(id, "completed");
        return c.json(deps.mask(existing), 200);
      }

      const resuming = state.status === "completing";
      const metadata = resuming ? await storage.getMetadata(session.key) : null;
      const objectReady = metadata !== null && metadata.size === session.size;

      const parts = objectReady ? state.parts : await collectParts(state);
      if (!objectReady) {
        const missing = missingParts(session, parts);
        if (missing.length > 0) {
          throw new ConflictError(`Upload is missing parts: ${JSON.stringify(missing)}`, { missingParts: missing });
        }
        for (const [partNumber, part] of parts) {
          const expected = expectedPartSize(session, partNumber);
          if (part.size !== expected) {
            throw new ValidationError(`Part ${partNumber} must be exactly ${expected} bytes (received ${part.size})`, {
              partNumber,
              expected,
              received: part.size,
            });
          }
        }
        if (session.mode === "fallback") {
          const vanished: number[] = [];
          for (const partNumber of parts.keys()) {
            if (!(await storage.exists(uploadPartKey(session, partNumber)))) vanished.push(partNumber);
          }
          if (vanished.length > 0) {
            for (const partNumber of vanished) await forgetUploadPart(id, partNumber);
            vanished.sort((a, b) => a - b);
            throw new ConflictError(`Upload is missing parts: ${JSON.stringify(vanished)}`, {
              missingParts: vanished,
            });
          }
        }
      }

      let mimeType = state.sniffedType;
      if (session.partCount === 0) {
        try {
          mimeType = deps.checkContent(session.declaredType, new Uint8Array(), true);
        } catch (error) {
          await failSession(state);
          throw error;
        }
      }

      await setUploadSessionStatus(id, "completing");
      let digest: string | undefined;
      if (!objectReady) digest = await assemble(state, parts);

      try {
        if (mimeType === undefined || session.direct) {
          const head = await readObjectHead(storage, session.key, SNIFF_BYTES);
          mimeType = deps.checkContent(session.declaredType, head, session.size <= SNIFF_BYTES);
        }
        const stored = await storage.getMetadata(session.key);
        if (!stored || stored.size !== session.size) {
          throw new ValidationError(`Assembled file is ${stored?.size ?? 0} bytes, expected ${session.size}`, {
            expected: session.size,
            received: stored?.size ?? 0,
          });
        }
        if (session.checksum) {
          const actual = digest ?? (await digestObject(session.key));
          if (actual !== session.checksum.value) {
            throw new ValidationError("File checksum mismatch", { algorithm: "sha256", expected: session.checksum.value });
          }
        }
      } catch (error) {
        await failSession({ ...state, status: "completing" });
        throw error;
      }

      const record = await deps.persist(c, {
        id: session.fileId,
        key: session.key,
        filename: session.filename,
        mimeType: mimeType!,
        size: session.size,
      });
      await setUploadSessionStatus(id, "completed");
      if (session.mode === "fallback" && session.partCount > 0) {
        await discardUploadArtifacts({ ...state, status: "completing" }, storage).catch(() => undefined);
      }
      return c.json(deps.mask(record), 201);
    } finally {
      await releaseCompletionLock(id);
    }
  });

  router.delete("/uploads/:uploadId", async (c) => {
    const state = await loadOwned(c, c.req.param("uploadId"));
    if (state.status === "completed") throw new ConflictError("Upload session is already completed");
    await abortSession(state);
    return c.body(null, 204);
  });
};
