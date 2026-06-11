import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";
import {
  createR2Adapter,
  R2BindingAdapter,
  R2S3Adapter,
  type R2Bucket,
} from "@/storage/r2";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({ type: "put", params })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({ type: "get", params })),
  DeleteObjectCommand: vi.fn().mockImplementation((params) => ({ type: "delete", params })),
  DeleteObjectsCommand: vi.fn().mockImplementation((params) => ({ type: "deleteMany", params })),
  HeadObjectCommand: vi.fn().mockImplementation((params) => ({ type: "head", params })),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://presigned.r2.example.com/file"),
}));

describe("R2 adapter (S3-compatible mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an S3-backed adapter from account credentials", () => {
    const adapter = createR2Adapter({
      accountId: "abc123",
      bucket: "my-bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    expect(adapter).toBeInstanceOf(R2S3Adapter);
    expect(adapter.supportsPresignedUrls()).toBe(true);
  });

  it("uploads via the underlying S3 client", async () => {
    mockSend.mockResolvedValueOnce({ ETag: '"r2etag"' });
    const adapter = createR2Adapter({
      accountId: "abc123",
      bucket: "my-bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });

    const result = await adapter.upload("test.txt", Buffer.from("hello"), {
      mimeType: "text/plain",
    });

    expect(result.key).toBe("test.txt");
    expect(result.etag).toBe("r2etag");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "put",
        params: expect.objectContaining({ Bucket: "my-bucket", Key: "test.txt" }),
      })
    );
  });

  it("uses the auto-derived account endpoint", async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    vi.mocked(S3Client).mockClear();
    mockSend.mockResolvedValueOnce({});

    const adapter = createR2Adapter({
      accountId: "my-account",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    await adapter.delete("k");

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "auto",
        endpoint: "https://my-account.r2.cloudflarestorage.com",
      })
    );
  });

  it("honors a custom endpoint override", async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    vi.mocked(S3Client).mockClear();
    mockSend.mockResolvedValueOnce({});

    const adapter = createR2Adapter({
      accountId: "my-account",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
      endpoint: "https://custom.example.com",
    });
    await adapter.delete("k");

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://custom.example.com" })
    );
  });

  it("returns a public URL when configured", () => {
    const adapter = createR2Adapter({
      accountId: "abc",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
      publicUrl: "https://cdn.example.com/",
    });
    expect(adapter.getUrl("path/file.png")).toBe("https://cdn.example.com/path/file.png");
  });

  it("returns null URL without a public URL", () => {
    const adapter = createR2Adapter({
      accountId: "abc",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    expect(adapter.getUrl("file.png")).toBeNull();
  });

  it("generates presigned download URLs", async () => {
    const adapter = createR2Adapter({
      accountId: "abc",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    const url = await adapter.getDownloadUrl("file.png");
    expect(url).toBe("https://presigned.r2.example.com/file");
  });
});

class FakeR2Bucket implements R2Bucket {
  private store = new Map<
    string,
    { data: Buffer; httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> }
  >();

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: any) {
    const buf =
      value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const entry = {
      data: buf,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.store.set(key, entry);
    return this.makeObject(key, entry);
  }

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return this.makeObject(key, entry);
  }

  async head(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return this.makeObject(key, entry);
  }

  async delete(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.store.delete(k);
  }

  has(key: string) {
    return this.store.has(key);
  }

  private makeObject(key: string, entry: { data: Buffer; httpMetadata?: any; customMetadata?: any }): any {
    return {
      key,
      size: entry.data.length,
      etag: "fake-etag",
      uploaded: new Date(),
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      arrayBuffer: async () =>
        entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength),
      body: Readable.toWeb(Readable.from(entry.data)) as unknown as ReadableStream,
    };
  }
}

describe("R2 adapter (bindings mode)", () => {
  let bucket: FakeR2Bucket;

  beforeEach(() => {
    bucket = new FakeR2Bucket();
  });

  it("creates a binding adapter when a binding is passed", () => {
    const adapter = createR2Adapter({ binding: bucket });
    expect(adapter).toBeInstanceOf(R2BindingAdapter);
    expect(adapter.supportsPresignedUrls()).toBe(false);
  });

  it("uploads and downloads via the binding", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    const result = await adapter.upload("hello.txt", Buffer.from("world"), {
      mimeType: "text/plain",
    });

    expect(result.key).toBe("hello.txt");
    expect(result.size).toBe(5);

    const data = await adapter.download("hello.txt");
    expect(data.toString()).toBe("world");
  });

  it("reports metadata", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    await adapter.upload("docs/readme.md", Buffer.from("# hi"), {
      mimeType: "text/markdown",
      customMetadata: { owner: "u1" },
    });

    const meta = await adapter.getMetadata("docs/readme.md");
    expect(meta).toMatchObject({
      key: "docs/readme.md",
      filename: "readme.md",
      mimeType: "text/markdown",
      size: 4,
      customMetadata: { owner: "u1" },
    });
  });

  it("returns null metadata for a missing key", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    expect(await adapter.getMetadata("missing")).toBeNull();
    expect(await adapter.exists("missing")).toBe(false);
  });

  it("streams downloads", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    await adapter.upload("s.txt", Buffer.from("streamed"));

    const stream = await adapter.downloadStream("s.txt");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe("streamed");
  });

  it("throws when downloading a missing key", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    await expect(adapter.download("nope")).rejects.toThrow("File not found");
  });

  it("deletes the underlying blob (orphan cleanup)", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    await adapter.upload("orphan.txt", Buffer.from("data"));
    expect(await adapter.exists("orphan.txt")).toBe(true);

    await adapter.delete("orphan.txt");

    expect(await adapter.exists("orphan.txt")).toBe(false);
    expect(bucket.has("orphan.txt")).toBe(false);
  });

  it("deletes many blobs", async () => {
    const adapter = createR2Adapter({ binding: bucket });
    await adapter.upload("a.txt", Buffer.from("a"));
    await adapter.upload("b.txt", Buffer.from("b"));

    await adapter.deleteMany(["a.txt", "b.txt"]);

    expect(await adapter.exists("a.txt")).toBe(false);
    expect(await adapter.exists("b.txt")).toBe(false);
  });

  it("returns a public URL when configured", () => {
    const adapter = createR2Adapter({ binding: bucket, publicUrl: "https://cdn.example.com" });
    expect(adapter.getUrl("x/y.png")).toBe("https://cdn.example.com/x/y.png");
  });
});
