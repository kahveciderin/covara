import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FetchTransport, TransportError } from "@/client/transport";
import { createFileClient, type ResumeStore } from "@/client/file-upload";
import { MemoryStorageAdapter } from "@/storage/memory";
import { resetStorageMaintenanceState } from "@/storage/cleanup";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { mountFiles, setupFilesDb, type FilesDb } from "../storage/helpers";

type Interceptor = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

const memoryStore = (): ResumeStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
};

describe("client resumable uploads", () => {
  let client: Awaited<ReturnType<typeof setupFilesDb>>["client"];
  let db: FilesDb;
  let storage: MemoryStorageAdapter;
  let originalFetch: typeof globalThis.fetch;
  let interceptor: Interceptor | undefined;
  let requests: { method: string; path: string }[];

  const install = (app: ReturnType<typeof mountFiles>) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ method: init.method ?? "GET", path: url.pathname });
      const intercepted = await interceptor?.(url, init);
      if (intercepted) return intercepted;
      return app.request(url.pathname + url.search, init);
    }) as typeof fetch;
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    return createFileClient({ transport, resourcePath: "/files" });
  };

  beforeEach(async () => {
    clearSchemaRegistry();
    resetStorageMaintenanceState();
    ({ client, db } = await setupFilesDb());
    storage = new MemoryStorageAdapter();
    originalFetch = globalThis.fetch;
    interceptor = undefined;
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
    resetStorageMaintenanceState();
  });

  const resumable = { partSize: 4, minPartSize: 1, maxPartSize: 1024 };
  const textFile = (content: string, name = "a.txt") =>
    new File([content], name, { type: "text/plain", lastModified: 1 });

  const partPuts = () => requests.filter((r) => r.method === "PUT" && r.path.includes("/parts/"));

  it("uploads in parallel parts, reports progress, and clears the resume record", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const store = memoryStore();
    const progress: number[] = [];
    const content = "the quick brown fox jumps";
    const file = await files.uploadResumable(textFile(content), {
      resumeStore: store,
      concurrency: 3,
      onProgress: (p) => progress.push(p.percent),
    });
    expect(file.size).toBe(content.length);
    expect(file.mimeType).toBe("text/plain");
    expect(progress[progress.length - 1]).toBe(100);
    expect(partPuts()).toHaveLength(7);
    expect(store.data.size).toBe(0);
    expect(await storedText(storage, file.storagePath)).toBe(content);
  });

  it("retries a part after a transient failure", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    let failures = 0;
    interceptor = (url, init) => {
      if (init.method === "PUT" && url.pathname.endsWith("/parts/2") && failures < 2) {
        failures++;
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    };
    const file = await files.uploadResumable(textFile("abcdefgh"), { resumeStore: memoryStore(), retryDelayMs: 1 });
    expect(failures).toBe(2);
    expect(file.size).toBe(8);
  });

  it("resumes after an interruption, uploading only the missing parts", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const store = memoryStore();
    interceptor = (url, init) => {
      if (init.method === "PUT" && url.pathname.endsWith("/parts/3")) throw new TypeError("network down");
      return undefined;
    };
    const content = "0123456789abcdef";
    await expect(
      files.uploadResumable(textFile(content), { resumeStore: store, maxRetries: 0, concurrency: 1 })
    ).rejects.toThrow(/network down/);
    expect(store.data.size).toBe(1);

    interceptor = undefined;
    requests = [];
    const file = await files.uploadResumable(textFile(content), { resumeStore: store, concurrency: 1 });
    expect(file.size).toBe(16);
    expect(partPuts().map((r) => r.path.split("/").pop())).toEqual(["3", "4"]);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/files/uploads")).toHaveLength(0);
    expect(store.data.size).toBe(0);
    expect(await storedText(storage, file.storagePath)).toBe(content);
  });

  it("starts a fresh session when the saved one has expired or vanished", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const store = memoryStore();
    const f = textFile("abcd");
    const key = `covara:resumable:/files:a.txt:4:1:text/plain`;
    store.data.set(key, JSON.stringify({ uploadId: "gone", size: 4, partSize: 4, partCount: 1, direct: false, expiresAt: "" }));
    const file = await files.uploadResumable(f, { resumeStore: store });
    expect(file.size).toBe(4);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/files/uploads")).toHaveLength(1);
  });

  it("abort() stops the upload and deletes the server session", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    interceptor = async (url, init) => {
      if (init.method === "PUT" && url.pathname.endsWith("/parts/2")) await gate;
      return undefined;
    };
    const handle = files.startResumableUpload(textFile("abcdefgh"), { resumeStore: store, concurrency: 1 });
    while (!handle.uploadId) await new Promise((r) => setTimeout(r, 1));
    const uploadId = handle.uploadId;
    const aborted = handle.abort();
    release();
    await aborted;
    await expect(handle.promise).rejects.toThrow();
    expect(store.data.size).toBe(0);
    await expect(files.getResumableUploadStatus(uploadId)).rejects.toMatchObject({ status: 404 });
    expect(storage.getKeys()).toEqual([]);
  });

  it("pause() keeps the session so it can be resumed later", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const store = memoryStore();
    const handle = files.startResumableUpload(textFile("abcdefgh"), { resumeStore: store, concurrency: 1 });
    handle.pause();
    await expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
    const file = await files.uploadResumable(textFile("abcdefgh"), { resumeStore: store });
    expect(file.size).toBe(8);
  });

  it("surfaces a content rejection and forgets the session", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable: { ...resumable, partSize: 64 } }));
    const store = memoryStore();
    const evil = new File(["<html><script>alert(1)</script></html>"], "x.png", { type: "image/png", lastModified: 1 });
    const error = await files.uploadResumable(evil, { resumeStore: store }).catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.status).toBe(400);
    expect(store.data.size).toBe(0);
  });

  it("handles zero-byte files", async () => {
    const files = install(mountFiles(db, storage, { id: "u1" }, { resumable }));
    const file = await files.uploadResumable(textFile(""), { resumeStore: false });
    expect(file.size).toBe(0);
    expect(partPuts()).toHaveLength(0);
  });

  it("sends the upload token for anonymous sessions and verifies checksums", async () => {
    const files = install(
      mountFiles(db, storage, null, { resumable, auth: { public: { create: true, read: true } } })
    );
    const file = await files.uploadResumable(textFile("abcdefgh"), { resumeStore: false, checksum: true });
    expect(file.size).toBe(8);
  });
});

const storedText = async (storage: MemoryStorageAdapter, key: string): Promise<string> =>
  (await storage.download(key)).toString();
