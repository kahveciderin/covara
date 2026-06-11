import { Readable } from "node:stream";
import {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
  S3StorageConfig,
} from "./types";

interface S3Client {
  send(command: unknown): Promise<unknown>;
}

interface S3CommandConstructor {
  new (input: unknown): unknown;
}

interface S3Response {
  Body?: {
    transformToByteArray(): Promise<Uint8Array>;
  } & Readable;
  ETag?: string;
  ContentLength?: number;
  ContentType?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
}

export class S3StorageAdapter implements StorageAdapter {
  private client: S3Client | null = null;
  private bucket: string;
  private config: S3StorageConfig;
  private presignedUrlExpiry: number;

  private PutObjectCommand: S3CommandConstructor | null = null;
  private GetObjectCommand: S3CommandConstructor | null = null;
  private DeleteObjectCommand: S3CommandConstructor | null = null;
  private DeleteObjectsCommand: S3CommandConstructor | null = null;
  private HeadObjectCommand: S3CommandConstructor | null = null;
  private getSignedUrl:
    | ((client: S3Client, command: unknown, options: { expiresIn: number }) => Promise<string>)
    | null = null;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.config = config;
    this.presignedUrlExpiry = config.presignedUrlExpiry ?? 3600;
  }

  private async ensureClient(): Promise<S3Client> {
    if (this.client) {
      return this.client;
    }

    try {
      const { S3Client: S3ClientClass } = await import("@aws-sdk/client-s3" as string);
      const {
        PutObjectCommand,
        GetObjectCommand,
        DeleteObjectCommand,
        DeleteObjectsCommand,
        HeadObjectCommand,
      } = await import("@aws-sdk/client-s3" as string);
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner" as string);

      this.PutObjectCommand = PutObjectCommand as S3CommandConstructor;
      this.GetObjectCommand = GetObjectCommand as S3CommandConstructor;
      this.DeleteObjectCommand = DeleteObjectCommand as S3CommandConstructor;
      this.DeleteObjectsCommand = DeleteObjectsCommand as S3CommandConstructor;
      this.HeadObjectCommand = HeadObjectCommand as S3CommandConstructor;
      this.getSignedUrl = getSignedUrl as typeof this.getSignedUrl;

      const clientConfig: Record<string, unknown> = {
        region: this.config.region ?? "us-east-1",
      };

      if (this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint;
      }

      if (this.config.accessKeyId && this.config.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        };
      }

      if (this.config.forcePathStyle) {
        clientConfig.forcePathStyle = true;
      }

      this.client = new S3ClientClass(clientConfig) as S3Client;
      return this.client;
    } catch {
      throw new Error(
        "AWS SDK is required for S3 storage. Install it with: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
      );
    }
  }

  async upload(
    key: string,
    data: Buffer | Readable,
    options?: UploadOptions
  ): Promise<UploadResult> {
    const client = await this.ensureClient();

    let body: Buffer | Readable;
    let size: number;

    if (Buffer.isBuffer(data)) {
      body = data;
      size = data.length;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
      size = body.length;
    }

    const command = new this.PutObjectCommand!({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: options?.mimeType,
      ContentEncoding: options?.contentEncoding,
      CacheControl: options?.cacheControl,
      Metadata: options?.customMetadata,
    });

    const response = (await client.send(command)) as S3Response;

    return {
      key,
      etag: response.ETag?.replace(/"/g, ""),
      size,
    };
  }

  async download(key: string): Promise<Buffer> {
    const client = await this.ensureClient();

    const command = new this.GetObjectCommand!({
      Bucket: this.bucket,
      Key: key,
    });

    const response = (await client.send(command)) as S3Response;

    if (!response.Body) {
      throw new Error(`File not found: ${key}`);
    }

    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async downloadStream(key: string): Promise<Readable> {
    const client = await this.ensureClient();

    const command = new this.GetObjectCommand!({
      Bucket: this.bucket,
      Key: key,
    });

    const response = (await client.send(command)) as S3Response;

    if (!response.Body || !(response.Body instanceof Readable)) {
      throw new Error(`File not found: ${key}`);
    }

    return response.Body;
  }

  async delete(key: string): Promise<void> {
    const client = await this.ensureClient();

    const command = new this.DeleteObjectCommand!({
      Bucket: this.bucket,
      Key: key,
    });

    await client.send(command);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const client = await this.ensureClient();

    const command = new this.DeleteObjectsCommand!({
      Bucket: this.bucket,
      Delete: {
        Objects: keys.map((key) => ({ Key: key })),
      },
    });

    await client.send(command);
  }

  async exists(key: string): Promise<boolean> {
    const metadata = await this.getMetadata(key);
    return metadata !== null;
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    const client = await this.ensureClient();

    try {
      const command = new this.HeadObjectCommand!({
        Bucket: this.bucket,
        Key: key,
      });

      const response = (await client.send(command)) as S3Response;

      return {
        key,
        filename: key.split("/").pop() ?? key,
        mimeType: response.ContentType ?? "application/octet-stream",
        size: response.ContentLength ?? 0,
        createdAt: response.LastModified ?? new Date(),
        etag: response.ETag?.replace(/"/g, ""),
        customMetadata: response.Metadata,
      };
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === "NotFound" || err.name === "NoSuchKey") {
        return null;
      }
      throw error;
    }
  }

  getUrl(_key: string): string | null {
    return null;
  }

  async getDownloadUrl(
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string | null> {
    const client = await this.ensureClient();

    const command = new this.GetObjectCommand!({
      Bucket: this.bucket,
      Key: key,
    });

    return this.getSignedUrl!(client, command, {
      expiresIn: options?.expiresIn ?? this.presignedUrlExpiry,
    });
  }

  async getUploadUrl(
    key: string,
    options?: PresignedUrlOptions
  ): Promise<PresignedUploadResult | null> {
    const client = await this.ensureClient();

    const commandParams: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: key,
    };

    if (options?.contentType) {
      commandParams.ContentType = options.contentType;
    }

    if (options?.contentLength) {
      commandParams.ContentLength = options.contentLength;
    }

    if (options?.metadata) {
      commandParams.Metadata = options.metadata;
    }

    const command = new this.PutObjectCommand!(commandParams);

    const expiresIn = options?.expiresIn ?? this.presignedUrlExpiry;
    const url = await this.getSignedUrl!(client, command, { expiresIn });

    return {
      url,
      key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  supportsPresignedUrls(): boolean {
    return true;
  }
}

export const createS3Storage = (config: S3StorageConfig): StorageAdapter => {
  return new S3StorageAdapter(config);
};
