import { Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat, readFile, writeFile, access, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
  LocalStorageConfig,
} from "./types";

interface LocalFileMetadata {
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt?: string;
  customMetadata?: Record<string, string>;
}

export class LocalStorageAdapter implements StorageAdapter {
  private basePath: string;
  private baseUrl?: string;
  private createDirectories: boolean;

  constructor(config: LocalStorageConfig) {
    this.basePath = resolve(config.basePath);
    this.baseUrl = config.baseUrl;
    this.createDirectories = config.createDirectories ?? true;
  }

  private getFilePath(key: string): string {
    return join(this.basePath, key);
  }

  private getMetadataPath(key: string): string {
    return join(this.basePath, `${key}.meta.json`);
  }

  private async ensureDirectory(filePath: string): Promise<void> {
    if (this.createDirectories) {
      await mkdir(dirname(filePath), { recursive: true });
    }
  }

  async upload(
    key: string,
    data: Buffer | Readable,
    options?: UploadOptions
  ): Promise<UploadResult> {
    const filePath = this.getFilePath(key);
    const metadataPath = this.getMetadataPath(key);

    await this.ensureDirectory(filePath);

    let size: number;
    let existingMeta: LocalFileMetadata | null = null;

    try {
      const metaContent = await readFile(metadataPath, "utf-8");
      existingMeta = JSON.parse(metaContent) as LocalFileMetadata;
    } catch {
      // No existing metadata
    }

    if (Buffer.isBuffer(data)) {
      await writeFile(filePath, data);
      size = data.length;
    } else {
      await new Promise<void>((resolvePromise, reject) => {
        const writeStream = createWriteStream(filePath);
        data.pipe(writeStream);
        writeStream.on("finish", resolvePromise);
        writeStream.on("error", reject);
        data.on("error", reject);
      });
      const stats = await stat(filePath);
      size = stats.size;
    }

    const now = new Date().toISOString();
    const metadata: LocalFileMetadata = {
      filename: options?.filename ?? key.split("/").pop() ?? key,
      mimeType: options?.mimeType ?? "application/octet-stream",
      size,
      createdAt: existingMeta?.createdAt ?? now,
      updatedAt: now,
      customMetadata: options?.customMetadata,
    };

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return {
      key,
      url: this.getUrl(key) ?? undefined,
      size,
    };
  }

  async download(key: string): Promise<Buffer> {
    const filePath = this.getFilePath(key);
    try {
      return await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${key}`);
      }
      throw error;
    }
  }

  async downloadStream(key: string): Promise<Readable> {
    const filePath = this.getFilePath(key);
    try {
      await access(filePath);
      return createReadStream(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${key}`);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metadataPath = this.getMetadataPath(key);

    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await unlink(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.delete(key)));
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    const metadataPath = this.getMetadataPath(key);
    const filePath = this.getFilePath(key);

    try {
      const content = await readFile(metadataPath, "utf-8");
      const meta = JSON.parse(content) as LocalFileMetadata;
      const stats = await stat(filePath);

      return {
        key,
        filename: meta.filename,
        mimeType: meta.mimeType,
        size: stats.size,
        createdAt: new Date(meta.createdAt),
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : undefined,
        customMetadata: meta.customMetadata,
      };
    } catch {
      return null;
    }
  }

  getUrl(key: string): string | null {
    if (!this.baseUrl) {
      return null;
    }
    return `${this.baseUrl}/${key}`;
  }

  // Used by startServer (Node) to auto-mount static serving so apps don't have
  // to wire serveStatic by hand. Returns null when no public baseUrl is set.
  getStaticServeConfig(): { basePath: string; baseUrl: string } | null {
    return this.baseUrl ? { basePath: this.basePath, baseUrl: this.baseUrl } : null;
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

  async clear(): Promise<void> {
    try {
      await rm(this.basePath, { recursive: true, force: true });
      await mkdir(this.basePath, { recursive: true });
    } catch {
      // Directory may not exist
    }
  }
}

export const createLocalStorage = (config: LocalStorageConfig): StorageAdapter => {
  return new LocalStorageAdapter(config);
};
