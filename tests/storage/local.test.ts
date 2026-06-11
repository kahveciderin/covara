import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLocalStorage, LocalStorageAdapter } from "@/storage/local";
import { Readable } from "stream";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { readFile, rm, mkdir } from "fs/promises";

describe("Local Storage Adapter", () => {
  let storage: LocalStorageAdapter;
  let basePath: string;

  beforeEach(async () => {
    basePath = join(tmpdir(), `covara-test-${randomUUID()}`);
    await mkdir(basePath, { recursive: true });
    storage = createLocalStorage({
      basePath,
      baseUrl: "/uploads",
      createDirectories: true,
    }) as LocalStorageAdapter;
  });

  afterEach(async () => {
    try {
      await rm(basePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("upload", () => {
    it("should upload a buffer", async () => {
      const data = Buffer.from("Hello, World!");
      const result = await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("test.txt");
      expect(result.size).toBe(data.length);
      expect(result.url).toBe("/uploads/test.txt");
    });

    it("should create file on disk", async () => {
      const data = Buffer.from("Hello, World!");
      await storage.upload("test.txt", data);

      const content = await readFile(join(basePath, "test.txt"), "utf-8");
      expect(content).toBe("Hello, World!");
    });

    it("should create metadata file", async () => {
      const data = Buffer.from("test");
      await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      const metaContent = await readFile(
        join(basePath, "test.txt.meta.json"),
        "utf-8"
      );
      const meta = JSON.parse(metaContent);
      expect(meta.filename).toBe("test.txt");
      expect(meta.mimeType).toBe("text/plain");
    });

    it("should upload a stream", async () => {
      const data = Buffer.from("Hello, Stream!");
      const stream = Readable.from(data);
      const result = await storage.upload("stream.txt", stream, {
        filename: "stream.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("stream.txt");
      expect(result.size).toBe(data.length);
    });

    it("should create nested directories", async () => {
      const data = Buffer.from("nested content");
      await storage.upload("path/to/nested/file.txt", data);

      const content = await readFile(
        join(basePath, "path/to/nested/file.txt"),
        "utf-8"
      );
      expect(content).toBe("nested content");
    });

    it("should update existing file", async () => {
      await storage.upload("test.txt", Buffer.from("original"));
      await storage.upload("test.txt", Buffer.from("updated"));

      const content = await readFile(join(basePath, "test.txt"), "utf-8");
      expect(content).toBe("updated");
    });

    it("should preserve createdAt on update", async () => {
      await storage.upload("test.txt", Buffer.from("original"));
      const original = await storage.getMetadata("test.txt");

      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.upload("test.txt", Buffer.from("updated"));
      const updated = await storage.getMetadata("test.txt");

      expect(updated?.createdAt.getTime()).toBe(original?.createdAt.getTime());
    });

    it("should store custom metadata", async () => {
      await storage.upload("test.txt", Buffer.from("data"), {
        customMetadata: { foo: "bar" },
      });

      const metadata = await storage.getMetadata("test.txt");
      expect(metadata?.customMetadata).toEqual({ foo: "bar" });
    });
  });

  describe("download", () => {
    it("should download a file", async () => {
      const data = Buffer.from("Hello, World!");
      await storage.upload("test.txt", data);

      const downloaded = await storage.download("test.txt");
      expect(downloaded.toString()).toBe("Hello, World!");
    });

    it("should throw for non-existent file", async () => {
      await expect(storage.download("nonexistent.txt")).rejects.toThrow(
        "File not found: nonexistent.txt"
      );
    });
  });

  describe("downloadStream", () => {
    it("should return a readable stream", async () => {
      const data = Buffer.from("Hello, Stream!");
      await storage.upload("test.txt", data);

      const stream = await storage.downloadStream("test.txt");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe("Hello, Stream!");
    });

    it("should throw for non-existent file", async () => {
      await expect(storage.downloadStream("nonexistent.txt")).rejects.toThrow(
        "File not found: nonexistent.txt"
      );
    });
  });

  describe("delete", () => {
    it("should delete file and metadata", async () => {
      await storage.upload("test.txt", Buffer.from("data"));
      await storage.delete("test.txt");

      expect(await storage.exists("test.txt")).toBe(false);
    });

    it("should not throw for non-existent file", async () => {
      await expect(storage.delete("nonexistent.txt")).resolves.not.toThrow();
    });
  });

  describe("deleteMany", () => {
    it("should delete multiple files", async () => {
      await storage.upload("file1.txt", Buffer.from("1"));
      await storage.upload("file2.txt", Buffer.from("2"));
      await storage.upload("file3.txt", Buffer.from("3"));

      await storage.deleteMany(["file1.txt", "file2.txt"]);

      expect(await storage.exists("file1.txt")).toBe(false);
      expect(await storage.exists("file2.txt")).toBe(false);
      expect(await storage.exists("file3.txt")).toBe(true);
    });
  });

  describe("exists", () => {
    it("should return true for existing file", async () => {
      await storage.upload("test.txt", Buffer.from("data"));

      expect(await storage.exists("test.txt")).toBe(true);
    });

    it("should return false for non-existent file", async () => {
      expect(await storage.exists("nonexistent.txt")).toBe(false);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata for existing file", async () => {
      const data = Buffer.from("Hello, World!");
      await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      const metadata = await storage.getMetadata("test.txt");
      expect(metadata).toMatchObject({
        key: "test.txt",
        filename: "test.txt",
        mimeType: "text/plain",
        size: data.length,
      });
      expect(metadata?.createdAt).toBeInstanceOf(Date);
    });

    it("should return null for non-existent file", async () => {
      const metadata = await storage.getMetadata("nonexistent.txt");
      expect(metadata).toBeNull();
    });
  });

  describe("getUrl", () => {
    it("should return URL when baseUrl is configured", () => {
      expect(storage.getUrl("test.txt")).toBe("/uploads/test.txt");
    });

    it("should handle nested paths", () => {
      expect(storage.getUrl("path/to/file.txt")).toBe(
        "/uploads/path/to/file.txt"
      );
    });

    it("should return null when baseUrl is not configured", () => {
      const storageNoUrl = createLocalStorage({
        basePath,
        createDirectories: true,
      }) as LocalStorageAdapter;
      expect(storageNoUrl.getUrl("test.txt")).toBeNull();
    });
  });

  describe("getDownloadUrl", () => {
    it("should return same as getUrl", async () => {
      await storage.upload("test.txt", Buffer.from("data"));
      expect(await storage.getDownloadUrl("test.txt")).toBe("/uploads/test.txt");
    });
  });

  describe("getUploadUrl", () => {
    it("should return null (local adapter does not support presigned URLs)", async () => {
      expect(await storage.getUploadUrl("test.txt")).toBeNull();
    });
  });

  describe("supportsPresignedUrls", () => {
    it("should return false", () => {
      expect(storage.supportsPresignedUrls()).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all files", async () => {
      await storage.upload("file1.txt", Buffer.from("1"));
      await storage.upload("file2.txt", Buffer.from("2"));

      await storage.clear();

      expect(await storage.exists("file1.txt")).toBe(false);
      expect(await storage.exists("file2.txt")).toBe(false);
    });
  });
});
