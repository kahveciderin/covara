import { Readable } from "node:stream";
import {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
} from "./types";

interface StoredFile {
  data: Buffer;
  metadata: FileMetadata;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private files = new Map<string, StoredFile>();

  async upload(
    key: string,
    data: Buffer | Readable,
    options?: UploadOptions
  ): Promise<UploadResult> {
    let buffer: Buffer;

    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    const now = new Date();
    const metadata: FileMetadata = {
      key,
      filename: options?.filename ?? key.split("/").pop() ?? key,
      mimeType: options?.mimeType ?? "application/octet-stream",
      size: buffer.length,
      createdAt: this.files.get(key)?.metadata.createdAt ?? now,
      updatedAt: now,
      customMetadata: options?.customMetadata,
    };

    this.files.set(key, { data: buffer, metadata });

    return {
      key,
      size: buffer.length,
    };
  }

  async download(key: string): Promise<Buffer> {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return file.data;
  }

  async downloadStream(key: string): Promise<Readable> {
    const buffer = await this.download(key);
    return Readable.from(buffer);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.files.delete(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    const file = this.files.get(key);
    return file?.metadata ?? null;
  }

  getUrl(_key: string): string | null {
    return null;
  }

  async getDownloadUrl(
    _key: string,
    _options?: PresignedUrlOptions
  ): Promise<string | null> {
    return null;
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

  clear(): void {
    this.files.clear();
  }

  getKeys(): string[] {
    return Array.from(this.files.keys());
  }
}

export const createMemoryStorage = (): StorageAdapter => {
  return new MemoryStorageAdapter();
};
