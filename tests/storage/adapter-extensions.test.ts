import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorageAdapter } from "@/storage/memory";
import { LocalStorageAdapter } from "@/storage/local";
import { S3StorageAdapter } from "@/storage/s3";
import { createR2Adapter, type R2Bucket, type R2MultipartUpload } from "@/storage/r2";
import { supportsMultipart, readObjectHead } from "@/storage/types";
import { listAllObjects } from "@/storage/list";

const mockSend = vi.fn();
const command = (type: string) => vi.fn().mockImplementation((params) => ({ type, params }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  PutObjectCommand: command("put"),
  GetObjectCommand: command("get"),
  DeleteObjectCommand: command("delete"),
  DeleteObjectsCommand: command("deleteMany"),
  HeadObjectCommand: command("head"),
  ListObjectsV2Command: command("list"),
  CreateMultipartUploadCommand: command("createMultipart"),
  UploadPartCommand: command("uploadPart"),
  CompleteMultipartUploadCommand: command("completeMultipart"),
  AbortMultipartUploadCommand: command("abortMultipart"),
  ListPartsCommand: command("listParts"),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockImplementation(async (_client, cmd: { type: string; params: Record<string, unknown> }) =>
    `https://signed.example.com/${cmd.type}?part=${String(cmd.params.PartNumber ?? "")}`
  ),
}));

describe("MemoryStorageAdapter extensions", () => {
  it("reads a byte range and clamps past the end", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.upload("a", Buffer.from("hello world"));
    expect((await storage.readRange("a", 0, 5)).toString()).toBe("hello");
    expect((await storage.readRange("a", 6, 100)).toString()).toBe("world");
    expect((await storage.readRange("a", 50, 4)).length).toBe(0);
    await expect(storage.readRange("missing", 0, 4)).rejects.toThrow(/not found/i);
  });

  it("lists keys by prefix with cursor pagination", async () => {
    const storage = new MemoryStorageAdapter();
    for (const key of ["p/a", "p/b", "p/c", "q/d"]) await storage.upload(key, Buffer.from(key));
    const first = await storage.list({ prefix: "p/", limit: 2 });
    expect(first.objects.map((o) => o.key)).toEqual(["p/a", "p/b"]);
    expect(first.cursor).toBe("p/b");
    const second = await storage.list({ prefix: "p/", limit: 2, cursor: first.cursor });
    expect(second.objects.map((o) => o.key)).toEqual(["p/c"]);
    expect(second.cursor).toBeUndefined();
    expect(second.objects[0].size).toBe(3);
    expect(second.objects[0].lastModified).toBeInstanceOf(Date);
  });

  it("listAllObjects walks every page", async () => {
    const storage = new MemoryStorageAdapter();
    for (let i = 0; i < 2500; i++) await storage.upload(`k/${String(i).padStart(5, "0")}`, Buffer.from("x"));
    let count = 0;
    for await (const _ of listAllObjects(storage, "k/")) count++;
    expect(count).toBe(2500);
  });

  it("is not a native multipart adapter (generic fallback is used)", () => {
    expect(supportsMultipart(new MemoryStorageAdapter())).toBe(false);
  });
});

describe("LocalStorageAdapter extensions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "covara-local-ext-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a byte range from disk", async () => {
    const storage = new LocalStorageAdapter({ basePath: dir });
    await storage.upload("nested/file.bin", Buffer.from("0123456789"));
    expect((await storage.readRange("nested/file.bin", 2, 3)).toString()).toBe("234");
    expect((await storage.readRange("nested/file.bin", 8, 10)).toString()).toBe("89");
    await expect(storage.readRange("nope", 0, 1)).rejects.toThrow(/not found/i);
  });

  it("lists object keys with forward slashes and hides .meta.json sidecars", async () => {
    const storage = new LocalStorageAdapter({ basePath: dir });
    await storage.upload("u1/a.txt", Buffer.from("a"));
    await storage.upload("u1/deep/b.txt", Buffer.from("bb"));
    await storage.upload("c.txt", Buffer.from("ccc"));
    const all = await storage.list();
    expect(all.objects.map((o) => o.key)).toEqual(["c.txt", "u1/a.txt", "u1/deep/b.txt"]);
    const scoped = await storage.list({ prefix: "u1/" });
    expect(scoped.objects.map((o) => o.size)).toEqual([1, 2]);
  });

  it("lists an empty result when the base path does not exist", async () => {
    const storage = new LocalStorageAdapter({ basePath: join(dir, "missing"), createDirectories: false });
    expect((await storage.list()).objects).toEqual([]);
  });

  it("readObjectHead falls back to download() for adapters without readRange", async () => {
    const storage = new LocalStorageAdapter({ basePath: dir });
    await storage.upload("x", Buffer.from("abcdef"));
    const bare = { ...storage, readRange: undefined, download: storage.download.bind(storage) } as unknown as LocalStorageAdapter;
    expect((await readObjectHead(bare, "x", 3)).toString()).toBe("abc");
  });
});

describe("S3StorageAdapter extensions", () => {
  let storage: S3StorageAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = new S3StorageAdapter({ bucket: "b", region: "us-east-1" });
  });

  it("reads a byte range with a Range header", async () => {
    mockSend.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const out = await storage.readRange("k", 10, 3);
    expect([...out]).toEqual([1, 2, 3]);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "get", params: expect.objectContaining({ Range: "bytes=10-12" }) })
    );
  });

  it("returns an empty buffer for an empty object (InvalidRange)", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("range"), { name: "InvalidRange" }));
    expect((await storage.readRange("k", 0, 10)).length).toBe(0);
  });

  it("maps NoSuchKey on a range read to a not-found error", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NoSuchKey" }));
    await expect(storage.readRange("k", 0, 10)).rejects.toThrow(/not found/i);
  });

  it("lists with ListObjectsV2 and continuation tokens", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    mockSend
      .mockResolvedValueOnce({ Contents: [{ Key: "a", Size: 1, LastModified: at }], IsTruncated: true, NextContinuationToken: "t1" })
      .mockResolvedValueOnce({ Contents: [{ Key: "b", Size: 2, LastModified: at }], IsTruncated: false });
    const keys: string[] = [];
    for await (const o of listAllObjects(storage, "pre/")) keys.push(o.key);
    expect(keys).toEqual(["a", "b"]);
    expect(mockSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "list", params: expect.objectContaining({ Prefix: "pre/", ContinuationToken: "t1" }) })
    );
  });

  it("runs the native multipart lifecycle", async () => {
    expect(supportsMultipart(storage)).toBe(true);
    mockSend.mockResolvedValueOnce({ UploadId: "up-1" });
    const { uploadId } = await storage.createMultipartUpload("big.bin", { mimeType: "application/octet-stream" });
    expect(uploadId).toBe("up-1");

    mockSend.mockResolvedValueOnce({ ETag: '"e1"' });
    const part = await storage.uploadPart("big.bin", "up-1", 1, Buffer.from("abc"));
    expect(part.etag).toBe('"e1"');
    expect(mockSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "uploadPart",
        params: expect.objectContaining({ Bucket: "b", Key: "big.bin", UploadId: "up-1", PartNumber: 1, ContentLength: 3 }),
      })
    );

    mockSend.mockResolvedValueOnce({ ETag: '"final"' });
    const done = await storage.completeMultipartUpload("big.bin", "up-1", [
      { partNumber: 2, etag: '"e2"', size: 2 },
      { partNumber: 1, etag: '"e1"', size: 3 },
    ]);
    expect(done).toEqual({ key: "big.bin", etag: "final", size: 5 });
    expect(mockSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "completeMultipart",
        params: expect.objectContaining({
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"e1"' }, { PartNumber: 2, ETag: '"e2"' }] },
        }),
      })
    );
  });

  it("ignores NoSuchUpload when aborting", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" }));
    await expect(storage.abortMultipartUpload("k", "u")).resolves.toBeUndefined();
    mockSend.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "InternalError" }));
    await expect(storage.abortMultipartUpload("k", "u")).rejects.toThrow("boom");
  });

  it("lists multipart parts across pages", async () => {
    mockSend
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 1, ETag: "a", Size: 5 }], IsTruncated: true, NextPartNumberMarker: "1" })
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 2, ETag: "b", Size: 3 }], IsTruncated: false });
    expect(await storage.listMultipartParts("k", "u")).toEqual([
      { partNumber: 1, etag: "a", size: 5 },
      { partNumber: 2, etag: "b", size: 3 },
    ]);
  });

  it("presigns an UploadPart URL", async () => {
    const url = await storage.getUploadPartUrl("k", "u", 7);
    expect(url).toBe("https://signed.example.com/uploadPart?part=7");
  });

  it("passes response overrides to presigned download URLs", async () => {
    await storage.getDownloadUrl("k", { responseContentType: "application/octet-stream", responseContentDisposition: "attachment" });
    const { GetObjectCommand } = await import("@aws-sdk/client-s3" as string);
    expect(GetObjectCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ ResponseContentType: "application/octet-stream", ResponseContentDisposition: "attachment" })
    );
  });

  it("declares S3 multipart limits", () => {
    expect(storage.multipartLimits.minPartSize).toBe(5 * 1024 * 1024);
    expect(storage.multipartLimits.maxParts).toBe(10000);
  });
});

const createFakeR2Bucket = (withMultipart = true): R2Bucket & { objects: Map<string, Buffer> } => {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const toObject = (key: string, data: Buffer) => ({
    key,
    size: data.length,
    etag: `etag-${key}`,
    uploaded: new Date(),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  });
  const resume = (key: string, uploadId: string): R2MultipartUpload => ({
    key,
    uploadId,
    async uploadPart(partNumber, value) {
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error("NoSuchUpload");
      upload.parts.set(partNumber, Buffer.from(value as Uint8Array));
      return { partNumber, etag: `p${partNumber}` };
    },
    async complete(parts) {
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error("NoSuchUpload");
      const data = Buffer.concat(parts.map((p) => upload.parts.get(p.partNumber)!));
      objects.set(key, data);
      uploads.delete(uploadId);
      return toObject(key, data);
    },
    async abort() {
      if (!uploads.delete(uploadId)) throw new Error("upload not found");
    },
  });
  const bucket: R2Bucket & { objects: Map<string, Buffer> } = {
    objects,
    async put(key, value) {
      objects.set(key, Buffer.from(value as Uint8Array));
      return toObject(key, objects.get(key)!);
    },
    async get(key, options) {
      const data = objects.get(key);
      if (!data) return null;
      const slice = options?.range ? data.subarray(options.range.offset, options.range.offset + options.range.length) : data;
      return toObject(key, slice);
    },
    async head(key) {
      const data = objects.get(key);
      return data ? toObject(key, data) : null;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options) {
      const all = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
      return { objects: all.map((k) => ({ key: k, size: objects.get(k)!.length, uploaded: new Date() })), truncated: false };
    },
  };
  if (withMultipart) {
    let n = 0;
    bucket.createMultipartUpload = async (key) => {
      const uploadId = `mp-${++n}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return resume(key, uploadId);
    };
    bucket.resumeMultipartUpload = (key, uploadId) => resume(key, uploadId);
  }
  return bucket;
};

describe("R2 binding adapter extensions", () => {
  it("reads ranges, lists, and runs native multipart via the binding", async () => {
    const bucket = createFakeR2Bucket();
    const storage = createR2Adapter({ binding: bucket });
    expect(supportsMultipart(storage)).toBe(true);

    await storage.upload("x.txt", Buffer.from("abcdef"));
    expect((await storage.readRange!("x.txt", 1, 3)).toString()).toBe("bcd");
    expect((await storage.readRange!("x.txt", 10, 3)).length).toBe(0);
    expect((await storage.list!({ prefix: "x" })).objects.map((o) => o.key)).toEqual(["x.txt"]);

    const { uploadId } = await storage.createMultipartUpload!("big", {});
    const p2 = await storage.uploadPart!("big", uploadId, 2, Buffer.from("world"));
    const p1 = await storage.uploadPart!("big", uploadId, 1, Buffer.from("hello "));
    const done = await storage.completeMultipartUpload!("big", uploadId, [
      { partNumber: 2, etag: p2.etag },
      { partNumber: 1, etag: p1.etag },
    ]);
    expect(done.size).toBe(11);
    expect(bucket.objects.get("big")!.toString()).toBe("hello world");
  });

  it("aborts idempotently", async () => {
    const storage = createR2Adapter({ binding: createFakeR2Bucket() });
    const { uploadId } = await storage.createMultipartUpload!("k", {});
    await storage.abortMultipartUpload!("k", uploadId);
    await expect(storage.abortMultipartUpload!("k", uploadId)).resolves.toBeUndefined();
  });

  it("reports no multipart support for bindings without it", () => {
    const storage = createR2Adapter({ binding: createFakeR2Bucket(false) });
    expect(supportsMultipart(storage)).toBe(false);
  });
});
