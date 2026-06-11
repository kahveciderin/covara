import { Readable } from "node:stream";
import {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
} from "./types";
import { S3StorageAdapter } from "./s3";

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: unknown): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
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

class R2BindingAdapter implements StorageAdapter {
  private bucket: R2Bucket;
  private publicUrl?: string;

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
