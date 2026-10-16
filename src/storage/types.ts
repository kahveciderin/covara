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
  contentDisposition?: string;
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
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface StoredObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ListObjectsOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ListObjectsResult {
  objects: StoredObjectInfo[];
  cursor?: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface MultipartLimits {
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
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

  readRange?(key: string, offset: number, length: number): Promise<Buffer>;

  list?(options?: ListObjectsOptions): Promise<ListObjectsResult>;

  multipartLimits?: MultipartLimits;

  supportsMultipartUpload?(): boolean;

  createMultipartUpload?(key: string, options?: UploadOptions): Promise<{ uploadId: string }>;

  uploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    data: Buffer
  ): Promise<{ etag: string }>;

  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: MultipartPart[]
  ): Promise<UploadResult>;

  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;

  listMultipartParts?(key: string, uploadId: string): Promise<MultipartPart[]>;

  getUploadPartUrl?(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: PresignedUrlOptions
  ): Promise<string | null>;
}

export type MultipartStorageAdapter = StorageAdapter &
  Required<
    Pick<
      StorageAdapter,
      "createMultipartUpload" | "uploadPart" | "completeMultipartUpload" | "abortMultipartUpload"
    >
  >;

export const supportsMultipart = (storage: StorageAdapter): storage is MultipartStorageAdapter =>
  typeof storage.createMultipartUpload === "function" &&
  typeof storage.uploadPart === "function" &&
  typeof storage.completeMultipartUpload === "function" &&
  typeof storage.abortMultipartUpload === "function" &&
  (storage.supportsMultipartUpload?.() ?? true);

export const readObjectHead = async (
  storage: StorageAdapter,
  key: string,
  length: number
): Promise<Buffer> => {
  if (typeof storage.readRange === "function") return storage.readRange(key, 0, length);
  const full = await storage.download(key);
  return full.subarray(0, length);
};

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
