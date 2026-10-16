import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import type { Hono } from "hono";
import { useFileResource, type FileResourceConfig } from "@/storage/resource";
import { MemoryStorageAdapter } from "@/storage/memory";
import type {
  MultipartPart,
  PresignedUploadResult,
  PresignedUrlOptions,
  StorageAdapter,
  UploadOptions,
  UploadResult,
} from "@/storage/types";
import { createTestApp } from "../helpers/hono";

export const filesTable = sqliteTable("sf_files", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const otherFilesTable = sqliteTable("sf_other_files", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

const ddl = (name: string): string => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    userId TEXT,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL,
    storagePath TEXT NOT NULL,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt INTEGER NOT NULL
  )
`;

export const setupFilesDb = async () => {
  const client = createLibsqlClient({ url: ":memory:" });
  const db = drizzle(client);
  await client.execute(ddl("sf_files"));
  await client.execute(ddl("sf_other_files"));
  return { client, db };
};

export type FilesDb = Awaited<ReturnType<typeof setupFilesDb>>["db"];

export const mountFiles = (
  db: FilesDb,
  storage: StorageAdapter,
  user: { id: string } | null,
  config: Partial<FileResourceConfig> = {},
  table = filesTable
): Hono => {
  const app = createTestApp({ user });
  app.route(
    "/files",
    useFileResource(table, { db, id: table.id, storage, ...config } as FileResourceConfig)
  );
  return app;
};

export const form = (name: string, content: string | Uint8Array, type = "text/plain"): FormData => {
  const fd = new FormData();
  fd.append("file", new File([content as BlobPart], name, { type }));
  return fd;
};

export class PresignedMemoryStorage extends MemoryStorageAdapter {
  supportsPresignedUrls(): boolean {
    return true;
  }

  async getUploadUrl(key: string, options?: PresignedUrlOptions): Promise<PresignedUploadResult | null> {
    return {
      url: `https://bucket.example.com/${key}`,
      key,
      expiresAt: new Date(Date.now() + (options?.expiresIn ?? 3600) * 1000),
    };
  }

  async getDownloadUrl(key: string, options?: PresignedUrlOptions): Promise<string | null> {
    const params = new URLSearchParams();
    if (options?.responseContentType) params.set("ct", options.responseContentType);
    if (options?.responseContentDisposition) params.set("cd", options.responseContentDisposition);
    return `https://bucket.example.com/${key}?${params.toString()}`;
  }
}

export class NativeMultipartMemoryStorage extends PresignedMemoryStorage {
  uploads = new Map<string, { key: string; parts: Map<number, Buffer>; options?: UploadOptions }>();
  calls: string[] = [];
  private seq = 0;

  async createMultipartUpload(key: string, options?: UploadOptions): Promise<{ uploadId: string }> {
    const uploadId = `native-${++this.seq}`;
    this.uploads.set(uploadId, { key, parts: new Map(), options });
    this.calls.push(`create:${key}`);
    return { uploadId };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Buffer): Promise<{ etag: string }> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
    upload.parts.set(partNumber, Buffer.from(data));
    this.calls.push(`part:${partNumber}`);
    return { etag: `"etag-${partNumber}-${data.length}"` };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<UploadResult> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const data = Buffer.concat(
      sorted.map((p) => {
        const part = upload.parts.get(p.partNumber);
        if (!part) throw new Error(`InvalidPart ${p.partNumber}`);
        return part;
      })
    );
    await this.upload(key, data, upload.options);
    this.uploads.delete(uploadId);
    this.calls.push(`complete:${key}`);
    return { key, size: data.length };
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
    this.calls.push(`abort:${uploadId}`);
  }

  async listMultipartParts(_key: string, uploadId: string): Promise<MultipartPart[]> {
    const upload = this.uploads.get(uploadId);
    if (!upload) return [];
    return [...upload.parts.entries()].map(([partNumber, data]) => ({
      partNumber,
      etag: `"etag-${partNumber}-${data.length}"`,
      size: data.length,
    }));
  }

  async getUploadPartUrl(key: string, uploadId: string, partNumber: number): Promise<string | null> {
    return `https://bucket.example.com/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }

  directPut(uploadId: string, partNumber: number, data: Buffer): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("NoSuchUpload");
    upload.parts.set(partNumber, data);
  }
}

export class FlakyDeleteStorage extends MemoryStorageAdapter {
  failDeletes = 0;
  deleteCalls = 0;

  async delete(key: string): Promise<void> {
    this.deleteCalls++;
    if (this.failDeletes > 0) {
      this.failDeletes--;
      throw new Error("storage unavailable");
    }
    return super.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }
}
