import { Readable } from "node:stream";

export interface FileMetadata {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt?: Date;
  etag?: string;
  contentEncoding?: string;
  customMetadata?: Record<string, string>;
}

export interface UploadOptions {
  filename?: string;
  mimeType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

export interface UploadResult {
  key: string;
  url?: string;
  etag?: string;
  size: number;
}

export interface PresignedUrlOptions {
  expiresIn?: number;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface PresignedUploadResult {
  url: string;
  fields?: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface StorageAdapter {
  upload(
    key: string,
    data: Buffer | Readable,
    options?: UploadOptions
  ): Promise<UploadResult>;

  download(key: string): Promise<Buffer>;

  downloadStream(key: string): Promise<Readable>;

  delete(key: string): Promise<void>;

  deleteMany(keys: string[]): Promise<void>;

  exists(key: string): Promise<boolean>;

  getMetadata(key: string): Promise<FileMetadata | null>;

  getUrl(key: string): string | null;

  getDownloadUrl(
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string | null>;

  getUploadUrl(
    key: string,
    options?: PresignedUrlOptions
  ): Promise<PresignedUploadResult | null>;

  supportsPresignedUrls(): boolean;
}

export interface LocalStorageConfig {
  basePath: string;
  baseUrl?: string;
  createDirectories?: boolean;
}

export interface S3StorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  presignedUrlExpiry?: number;
}

export interface StorageConfig {
  type: "memory" | "local" | "s3" | "r2";
  local?: LocalStorageConfig;
  s3?: S3StorageConfig;
  r2?: unknown;
}

let globalStorage: StorageAdapter | null = null;

export const setGlobalStorage = (storage: StorageAdapter): void => {
  globalStorage = storage;
};

export const getGlobalStorage = (): StorageAdapter => {
  if (!globalStorage) {
    throw new Error(
      "Storage not initialized. Call setGlobalStorage() or initializeStorage() first."
    );
  }
  return globalStorage;
};

export const hasGlobalStorage = (): boolean => {
  return globalStorage !== null;
};

export const clearGlobalStorage = (): void => {
  globalStorage = null;
};
