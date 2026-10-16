import { Transport, TransportError } from "./transport";

export interface FileUploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  metadata?: Record<string, string>;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadedFile {
  id: string;
  userId?: string | null;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url?: string | null;
  status: "pending" | "completed" | "rejected";
  createdAt: string;
}

export interface ResumeStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface ResumableUploadOptions {
  partSize?: number;
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  checksum?: boolean;
  direct?: boolean;
  resumeKey?: string;
  resumeStore?: ResumeStore | false;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onSessionCreated?: (session: ResumableUploadSession) => void;
}

export interface ResumableUploadSession {
  uploadId: string;
  uploadToken?: string;
  size: number;
  partSize: number;
  partCount: number;
  direct: boolean;
  expiresAt: string;
}

export interface ResumableUploadStatus {
  uploadId: string;
  filename: string;
  size: number;
  partSize: number;
  partCount: number;
  status: "active" | "completing" | "completed" | "failed";
  direct: boolean;
  expiresAt: string;
  parts: { partNumber: number; size: number; etag: string }[];
  missingParts: number[];
  receivedBytes: number;
  mimeType: string | null;
  fileId: string | null;
}

export interface ResumableUploadHandle {
  readonly promise: Promise<UploadedFile>;
  readonly uploadId: string | null;
  pause(): void;
  abort(): Promise<void>;
}

export type UploadableFile = Blob & { name?: string; lastModified?: number };

const UPLOAD_TOKEN_HEADER = "Covara-Upload-Token";
const PART_SHA256_HEADER = "Covara-Part-Sha256";
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const memoryResumeStore = new Map<string, string>();

const defaultResumeStore = (): ResumeStore => {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      const probe = "__covara_resumable_probe__";
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return {
        get: (key) => storage.getItem(key),
        set: (key, value) => storage.setItem(key, value),
        remove: (key) => storage.removeItem(key),
      };
    }
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall back to memory.
  }
  return {
    get: (key) => memoryResumeStore.get(key) ?? null,
    set: (key, value) => void memoryResumeStore.set(key, value),
    remove: (key) => void memoryResumeStore.delete(key),
  };
};

const nullResumeStore: ResumeStore = { get: () => null, set: () => undefined, remove: () => undefined };

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError("Upload paused"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError("Upload paused"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isRetryable = (error: unknown): boolean => {
  if ((error as Error)?.name === "AbortError") return false;
  if (error instanceof TransportError) return RETRYABLE_STATUSES.has(error.status);
  return true;
};

const isSessionGone = (error: unknown): boolean =>
  error instanceof TransportError && (error.status === 404 || error.status === 410);

const sha256Hex = async (blob: Blob): Promise<string | undefined> => {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface PresignedUploadResponse {
  fileId: string;
  uploadUrl: string;
  fields?: Record<string, string>;
  key: string;
  expiresAt: string;
}

export interface FileClient {
  upload(file: File, options?: FileUploadOptions): Promise<UploadedFile>;
  uploadWithPresignedUrl(file: File, options?: FileUploadOptions): Promise<UploadedFile>;
  get(id: string): Promise<UploadedFile>;
  list(options?: FileListOptions): Promise<FileListResponse>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<{ deleted: number }>;
  getDownloadUrl(id: string): string;
  uploadResumable(file: UploadableFile, options?: ResumableUploadOptions): Promise<UploadedFile>;
  startResumableUpload(file: UploadableFile, options?: ResumableUploadOptions): ResumableUploadHandle;
  getResumableUploadStatus(uploadId: string, uploadToken?: string): Promise<ResumableUploadStatus>;
  abortResumableUpload(uploadId: string, uploadToken?: string): Promise<void>;
}

export interface FileListOptions {
  limit?: number;
  offset?: number;
  filter?: string;
}

export interface FileListResponse {
  items: UploadedFile[];
  nextCursor?: string | null;
}

export interface FileClientConfig {
  transport: Transport;
  resourcePath: string;
}

export const createFileClient = (config: FileClientConfig): FileClient => {
  const { transport, resourcePath } = config;

  const upload = async (
    file: File,
    options?: FileUploadOptions
  ): Promise<UploadedFile> => {
    const formData = new FormData();
    formData.append("file", file);

    if (options?.metadata) {
      formData.append("metadata", JSON.stringify(options.metadata));
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (options?.onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            options.onProgress!({
              loaded: event.loaded,
              total: event.total,
              percent: Math.round((event.loaded / event.total) * 100),
            });
          }
        });
      }

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve(response as UploadedFile);
          } catch {
            reject(new Error("Invalid response format"));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error?.message || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Network error during upload"));
      });

      xhr.addEventListener("abort", () => {
        reject(new Error("Upload aborted"));
      });

      const baseUrl = (transport as unknown as { config: { baseUrl: string } }).config?.baseUrl || "";
      xhr.open("POST", `${baseUrl}${resourcePath}`);

      const headers = (transport as unknown as { headers?: Record<string, string> }).headers;
      if (headers) {
        Object.entries(headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== "content-type") {
            xhr.setRequestHeader(key, value);
          }
        });
      }

      xhr.withCredentials = true;
      xhr.send(formData);
    });
  };

  const uploadWithPresignedUrl = async (
    file: File,
    options?: FileUploadOptions
  ): Promise<UploadedFile> => {
    const params = new URLSearchParams({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    });

    const presignedResponse = await transport.request<PresignedUploadResponse>({
      method: "GET",
      path: `${resourcePath}/upload-url`,
      params: Object.fromEntries(params),
    });

    const { fileId, uploadUrl, fields } = presignedResponse.data;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (options?.onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            options.onProgress!({
              loaded: event.loaded,
              total: event.total,
              percent: Math.round((event.loaded / event.total) * 100),
            });
          }
        });
      }

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Network error during upload"));
      });

      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

      if (fields) {
        Object.entries(fields).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });
      }

      xhr.send(file);
    });

    const confirmResponse = await transport.request<UploadedFile>({
      method: "POST",
      path: `${resourcePath}/${fileId}/confirm`,
    });

    return confirmResponse.data;
  };

  const get = async (id: string): Promise<UploadedFile> => {
    const response = await transport.request<UploadedFile>({
      method: "GET",
      path: `${resourcePath}/${id}`,
    });
    return response.data;
  };

  const list = async (options?: FileListOptions): Promise<FileListResponse> => {
    const params: Record<string, string | number> = {};
    if (options?.limit) params.limit = options.limit;
    if (options?.offset) params.offset = options.offset;
    if (options?.filter) params.filter = options.filter;

    const response = await transport.request<FileListResponse>({
      method: "GET",
      path: resourcePath,
      params,
    });
    return response.data;
  };

  const deleteFile = async (id: string): Promise<void> => {
    await transport.request({
      method: "DELETE",
      path: `${resourcePath}/${id}`,
    });
  };

  const deleteMany = async (ids: string[]): Promise<{ deleted: number }> => {
    const response = await transport.request<{ deleted: number }>({
      method: "DELETE",
      path: `${resourcePath}/batch`,
      body: { ids },
    });
    return response.data;
  };

  const getDownloadUrl = (id: string): string => {
    const baseUrl = (transport as unknown as { config: { baseUrl: string } }).config?.baseUrl || "";
    return `${baseUrl}${resourcePath}/${id}/download`;
  };

  const tokenHeaders = (uploadToken?: string): Record<string, string> =>
    uploadToken ? { [UPLOAD_TOKEN_HEADER]: uploadToken } : {};

  const getResumableUploadStatus = async (
    uploadId: string,
    uploadToken?: string,
    signal?: AbortSignal
  ): Promise<ResumableUploadStatus> => {
    const response = await transport.request<ResumableUploadStatus>({
      method: "GET",
      path: `${resourcePath}/uploads/${uploadId}`,
      headers: tokenHeaders(uploadToken),
      signal,
    });
    return response.data;
  };

  const abortResumableUpload = async (uploadId: string, uploadToken?: string): Promise<void> => {
    try {
      await transport.request({
        method: "DELETE",
        path: `${resourcePath}/uploads/${uploadId}`,
        headers: tokenHeaders(uploadToken),
      });
    } catch (error) {
      if (!isSessionGone(error)) throw error;
    }
  };

  const startResumableUpload = (
    file: UploadableFile,
    options: ResumableUploadOptions = {}
  ): ResumableUploadHandle => {
    const store = options.resumeStore === false ? nullResumeStore : options.resumeStore ?? defaultResumeStore();
    const resumeKey =
      options.resumeKey ??
      `covara:resumable:${resourcePath}:${file.name ?? "blob"}:${file.size}:${file.lastModified ?? 0}:${file.type}`;
    const concurrency = Math.max(1, options.concurrency ?? 3);
    const maxRetries = options.maxRetries ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    let session: ResumableUploadSession | null = null;

    const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw abortError("Upload paused");
        try {
          return await fn();
        } catch (error) {
          if (signal.aborted) throw abortError("Upload paused");
          if (attempt >= maxRetries || !isRetryable(error)) throw error;
          await sleep(Math.min(retryDelayMs * 2 ** attempt, 30_000), signal);
        }
      }
    };

    const saveSession = async (value: ResumableUploadSession): Promise<void> => {
      try {
        await store.set(resumeKey, JSON.stringify(value));
      } catch {
        // A failed resume record only costs resumability, never the upload itself.
      }
    };

    const forgetSession = async (): Promise<void> => {
      try {
        await store.remove(resumeKey);
      } catch {
        // See saveSession.
      }
    };

    const loadSaved = async (): Promise<ResumableUploadSession | null> => {
      try {
        const raw = await store.get(resumeKey);
        return raw ? (JSON.parse(raw) as ResumableUploadSession) : null;
      } catch {
        return null;
      }
    };

    const createSession = async (): Promise<ResumableUploadSession> => {
      let checksum: { algorithm: "sha256"; value: string } | undefined;
      if (options.checksum) {
        const value = await sha256Hex(file);
        if (value) checksum = { algorithm: "sha256", value };
      }
      const response = await withRetry(() =>
        transport.request<ResumableUploadSession>({
          method: "POST",
          path: `${resourcePath}/uploads`,
          body: {
            filename: file.name ?? "blob",
            size: file.size,
            contentType: file.type || undefined,
            partSize: options.partSize,
            direct: options.direct === true,
            ...(checksum ? { checksum } : {}),
          },
          signal,
        })
      );
      return response.data;
    };

    const uploadPart = async (current: ResumableUploadSession, partNumber: number): Promise<number> => {
      const start = (partNumber - 1) * current.partSize;
      const blob = file.slice(start, Math.min(start + current.partSize, file.size));
      const headers: Record<string, string> = { ...tokenHeaders(current.uploadToken) };
      if (options.checksum) {
        const digest = await sha256Hex(blob);
        if (digest) headers[PART_SHA256_HEADER] = digest;
      }
      await withRetry(async () => {
        if (current.direct) {
          const { data } = await transport.request<{ url: string }>({
            method: "GET",
            path: `${resourcePath}/uploads/${current.uploadId}/parts/${partNumber}/url`,
            headers: tokenHeaders(current.uploadToken),
            signal,
          });
          const res = await fetch(data.url, { method: "PUT", body: blob, signal });
          if (!res.ok) throw new TransportError(`Part upload failed: ${res.status}`, res.status, "PART_UPLOAD_FAILED");
          return;
        }
        await transport.request({
          method: "PUT",
          path: `${resourcePath}/uploads/${current.uploadId}/parts/${partNumber}`,
          rawBody: blob,
          headers,
          signal,
        });
      });
      return blob.size;
    };

    const runParts = async (current: ResumableUploadSession, pending: number[], loadedStart: number) => {
      let loaded = loadedStart;
      const report = () =>
        options.onProgress?.({
          loaded,
          total: file.size,
          percent: file.size === 0 ? 100 : Math.round((loaded / file.size) * 100),
        });
      report();
      const queue = [...pending];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const size = await uploadPart(current, next);
          loaded += size;
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));
    };

    const complete = async (current: ResumableUploadSession): Promise<UploadedFile> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await withRetry(() =>
            transport.request<UploadedFile>({
              method: "POST",
              path: `${resourcePath}/uploads/${current.uploadId}/complete`,
              headers: tokenHeaders(current.uploadToken),
              signal,
            })
          );
          return response.data;
        } catch (error) {
          if (!(error instanceof TransportError) || error.status !== 409 || attempt >= maxRetries) throw error;
          const status = await getResumableUploadStatus(current.uploadId, current.uploadToken, signal);
          if (status.status === "completed" && status.fileId) return get(status.fileId);
          if (status.status === "active" && status.missingParts.length > 0) {
            await runParts(current, status.missingParts, status.receivedBytes);
          } else {
            await sleep(Math.min(retryDelayMs * 2 ** attempt, 30_000), signal);
          }
        }
      }
    };

    const resume = async (): Promise<{ session: ResumableUploadSession; status: ResumableUploadStatus } | null> => {
      const saved = await loadSaved();
      if (!saved || saved.size !== file.size) return null;
      try {
        const status = await getResumableUploadStatus(saved.uploadId, saved.uploadToken, signal);
        if (status.status === "failed") return null;
        return { session: saved, status };
      } catch (error) {
        if (isSessionGone(error)) return null;
        throw error;
      }
    };

    const run = async (): Promise<UploadedFile> => {
      for (let restart = 0; ; restart++) {
        const resumed = await resume();
        if (!resumed) await forgetSession();
        if (resumed?.status.status === "completed" && resumed.status.fileId) {
          await forgetSession();
          return get(resumed.status.fileId);
        }
        session = resumed?.session ?? (await createSession());
        if (!resumed) {
          await saveSession(session);
          options.onSessionCreated?.(session);
        }
        const done = new Set(resumed?.status.parts.map((p) => p.partNumber) ?? []);
        const pending = Array.from({ length: session.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
        try {
          await runParts(session, pending, resumed?.status.receivedBytes ?? 0);
          const result = await complete(session);
          await forgetSession();
          return result;
        } catch (error) {
          if (isSessionGone(error) && restart === 0) {
            await forgetSession();
            continue;
          }
          if (error instanceof TransportError && error.status < 500 && !RETRYABLE_STATUSES.has(error.status)) {
            await forgetSession();
          }
          throw error;
        }
      }
    };

    const promise = run();
    promise.catch(() => undefined);

    return {
      promise,
      get uploadId() {
        return session?.uploadId ?? null;
      },
      pause: () => controller.abort(),
      abort: async () => {
        controller.abort();
        await promise.catch(() => undefined);
        const current = session ?? (await loadSaved());
        await forgetSession();
        if (current) await abortResumableUpload(current.uploadId, current.uploadToken);
      },
    };
  };

  const uploadResumable = (file: UploadableFile, options?: ResumableUploadOptions): Promise<UploadedFile> =>
    startResumableUpload(file, options).promise;

  return {
    upload,
    uploadWithPresignedUrl,
    get,
    list,
    delete: deleteFile,
    deleteMany,
    getDownloadUrl,
    uploadResumable,
    startResumableUpload,
    getResumableUploadStatus: (uploadId, uploadToken) => getResumableUploadStatus(uploadId, uploadToken),
    abortResumableUpload,
  };
};
