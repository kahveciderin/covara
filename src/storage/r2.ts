import { Readable } from "node:stream";
import {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
  ListObjectsOptions,
  ListObjectsResult,
  MultipartLimits,
  MultipartPart,
} from "./types";
import { S3StorageAdapter } from "./s3";

export interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView
  ): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<R2Object>;
  abort(): Promise<void>;
}

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: unknown): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<R2Object | null>;
  head(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list?(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: { key: string; size: number; uploaded?: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  createMultipartUpload?(key: string, options?: unknown): Promise<R2MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUpload;
}

interface R2Object {
  key: string;
  size: number;
  etag?: string;
  httpEtag?: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string; contentEncoding?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream;
}

export interface R2S3Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  presignedUrlExpiry?: number;
  publicUrl?: string;
}

export interface R2BindingConfig {
  binding: R2Bucket;
  publicUrl?: string;
}

export type R2StorageConfig = R2S3Config | R2BindingConfig;

const isBindingConfig = (config: R2StorageConfig): config is R2BindingConfig => {
  return "binding" in config && config.binding != null;
};

const toBuffer = async (data: Buffer | Readable): Promise<Buffer> => {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const MIB = 1024 * 1024;

class R2BindingAdapter implements StorageAdapter {
  private bucket: R2Bucket;
  private publicUrl?: string;

  readonly multipartLimits: MultipartLimits = {
    minPartSize: 5 * MIB,
    maxPartSize: 5 * 1024 * MIB,
    maxParts: 10000,
  };

  constructor(config: R2BindingConfig) {
    this.bucket = config.binding;
    this.publicUrl = config.publicUrl;
  }

  async upload(
    key: string,
    data: Buffer | Readable,
    options?: UploadOptions
  ): Promise<UploadResult> {
    const buffer = await toBuffer(data);

    const object = (await this.bucket.put(key, buffer, {
      httpMetadata: {
        contentType: options?.mimeType,
        contentEncoding: options?.contentEncoding,
        cacheControl: options?.cacheControl,
        ...(options?.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      },
      customMetadata: options?.customMetadata,
    })) as R2Object | null;

    return {
      key,
      url: this.getUrl(key) ?? undefined,
      etag: object?.etag ?? object?.httpEtag?.replace(/"/g, ""),
      size: buffer.length,
    };
  }

  async download(key: string): Promise<Buffer> {
    const object = await this.bucket.get(key);
    if (!object) {
      throw new Error(`File not found: ${key}`);
    }
    const bytes = await object.arrayBuffer();
    return Buffer.from(bytes);
  }

  async downloadStream(key: string): Promise<Readable> {
    const object = await this.bucket.get(key);
    if (!object || !object.body) {
      throw new Error(`File not found: ${key}`);
    }
    return Readable.fromWeb(object.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const head = await this.bucket.head(key);
    if (!head) throw new Error(`File not found: ${key}`);
    if (offset >= head.size) return Buffer.alloc(0);
    const object = await this.bucket.get(key, {
      range: { offset, length: Math.min(length, head.size - offset) },
    });
    if (!object) throw new Error(`File not found: ${key}`);
    return Buffer.from(await object.arrayBuffer());
  }

  async list(options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    if (typeof this.bucket.list !== "function") return { objects: [] };
    const page = await this.bucket.list({
      prefix: options.prefix || undefined,
      cursor: options.cursor,
      limit: options.limit ?? 1000,
    });
    return {
      objects: page.objects.map((o) => ({
        key: o.key,
        size: o.size,
        lastModified: o.uploaded ?? new Date(0),
      })),
      cursor: page.truncated ? page.cursor : undefined,
    };
  }

  supportsMultipartUpload(): boolean {
    return (
      typeof this.bucket.createMultipartUpload === "function" &&
      typeof this.bucket.resumeMultipartUpload === "function"
    );
  }

  private resume(key: string, uploadId: string): R2MultipartUpload {
    if (!this.supportsMultipartUpload()) {
      throw new Error("This R2 binding does not support multipart uploads");
    }
    return this.bucket.resumeMultipartUpload!(key, uploadId);
  }

  async createMultipartUpload(key: string, options?: UploadOptions): Promise<{ uploadId: string }> {
    if (!this.supportsMultipartUpload()) {
      throw new Error("This R2 binding does not support multipart uploads");
    }
    const upload = await this.bucket.createMultipartUpload!(key, {
      httpMetadata: {
        contentType: options?.mimeType,
        ...(options?.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      },
      customMetadata: options?.customMetadata,
    });
    return { uploadId: upload.uploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    data: Buffer
  ): Promise<{ etag: string }> {
    const part = await this.resume(key, uploadId).uploadPart(partNumber, data);
    return { etag: part.etag };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[]
  ): Promise<UploadResult> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const object = await this.resume(key, uploadId).complete(
      sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
    );
    return {
      key,
      url: this.getUrl(key) ?? undefined,
      etag: object?.etag ?? object?.httpEtag?.replace(/"/g, ""),
      size: object?.size ?? sorted.reduce((sum, p) => sum + (p.size ?? 0), 0),
    };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.resume(key, uploadId).abort();
    } catch (error) {
      if (/not ?found|NoSuchUpload/i.test(String((error as Error)?.message ?? error))) return;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.bucket.delete(keys);
  }

  async exists(key: string): Promise<boolean> {
    const object = await this.bucket.head(key);
    return object !== null;
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    const object = await this.bucket.head(key);
    if (!object) {
      return null;
    }
    return {
      key,
      filename: key.split("/").pop() ?? key,
      mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
      createdAt: object.uploaded ?? new Date(),
      etag: object.etag ?? object.httpEtag?.replace(/"/g, ""),
      contentEncoding: object.httpMetadata?.contentEncoding,
      customMetadata: object.customMetadata,
    };
  }

  getUrl(key: string): string | null {
    if (!this.publicUrl) {
      return null;
    }
    return `${this.publicUrl.replace(/\/$/, "")}/${key}`;
  }

  async getDownloadUrl(
    key: string,
    _options?: PresignedUrlOptions
  ): Promise<string | null> {
    return this.getUrl(key);
  }

  async getUploadUrl(
    _key: string,
    _options?: PresignedUrlOptions
  ): Promise<PresignedUploadResult | null> {
    return null;
  }

  supportsPresignedUrls(): boolean {
    return false;
  }
}

class R2S3Adapter extends S3StorageAdapter {
  private publicUrl?: string;

  constructor(config: R2S3Config) {
    const endpoint =
      config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
    super({
      bucket: config.bucket,
      region: "auto",
      endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      presignedUrlExpiry: config.presignedUrlExpiry,
    });
    this.publicUrl = config.publicUrl;
  }

  getUrl(key: string): string | null {
    if (!this.publicUrl) {
      return null;
    }
    return `${this.publicUrl.replace(/\/$/, "")}/${key}`;
  }
}

export const createR2Adapter = (config: R2StorageConfig): StorageAdapter => {
  if (isBindingConfig(config)) {
    return new R2BindingAdapter(config);
  }
  return new R2S3Adapter(config);
};

export { R2BindingAdapter, R2S3Adapter };
