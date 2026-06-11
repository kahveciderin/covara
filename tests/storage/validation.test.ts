import { describe, it, expect } from "vitest";
import { validateUpload } from "@/storage/validation";
import { createMemoryStorage, MemoryStorageAdapter } from "@/storage/memory";
import { ValidationError } from "@/resource/error";

describe("validateUpload", () => {
  describe("max size", () => {
    it("accepts files within the limit", () => {
      expect(() =>
        validateUpload({ size: 500, contentType: "text/plain" }, { maxSize: 1000 })
      ).not.toThrow();
    });

    it("rejects files over the limit", () => {
      expect(() =>
        validateUpload({ size: 2000, contentType: "text/plain" }, { maxSize: 1000 })
      ).toThrow(ValidationError);
    });

    it("includes size details in the error", () => {
      try {
        validateUpload({ size: 2000 }, { maxSize: 1000 });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).details).toMatchObject({
          maxSize: 1000,
          size: 2000,
        });
      }
    });

    it("ignores size check when size is unknown", () => {
      expect(() => validateUpload({}, { maxSize: 1000 })).not.toThrow();
    });
  });

  describe("allowlist", () => {
    it("accepts an allowed exact type", () => {
      expect(() =>
        validateUpload({ contentType: "image/png" }, { allowedTypes: ["image/png"] })
      ).not.toThrow();
    });

    it("rejects a type not in the allowlist", () => {
      expect(() =>
        validateUpload(
          { contentType: "application/pdf" },
          { allowedTypes: ["image/png", "image/jpeg"] }
        )
      ).toThrow(ValidationError);
    });

    it("supports wildcard subtypes", () => {
      expect(() =>
        validateUpload({ contentType: "image/webp" }, { allowedTypes: ["image/*"] })
      ).not.toThrow();
      expect(() =>
        validateUpload({ contentType: "video/mp4" }, { allowedTypes: ["image/*"] })
      ).toThrow(ValidationError);
    });

    it("is case-insensitive and strips parameters", () => {
      expect(() =>
        validateUpload(
          { contentType: "TEXT/PLAIN; charset=utf-8" },
          { allowedTypes: ["text/plain"] }
        )
      ).not.toThrow();
    });

    it("rejects when content type is missing but allowlist is set", () => {
      expect(() =>
        validateUpload({}, { allowedTypes: ["image/png"] })
      ).toThrow(ValidationError);
    });
  });

  describe("blocklist", () => {
    it("rejects a blocked type", () => {
      expect(() =>
        validateUpload(
          { contentType: "application/x-msdownload" },
          { blockedTypes: ["application/x-msdownload"] }
        )
      ).toThrow(ValidationError);
    });

    it("accepts a non-blocked type", () => {
      expect(() =>
        validateUpload({ contentType: "image/png" }, { blockedTypes: ["application/x-msdownload"] })
      ).not.toThrow();
    });

    it("supports wildcard blocking", () => {
      expect(() =>
        validateUpload({ contentType: "application/x-sh" }, { blockedTypes: ["application/*"] })
      ).toThrow(ValidationError);
    });
  });

  describe("no options", () => {
    it("passes when no constraints are configured", () => {
      expect(() =>
        validateUpload({ contentType: "anything/here", size: 9999 }, {})
      ).not.toThrow();
    });
  });
});

describe("orphan cleanup", () => {
  it("removes the underlying blob when the key is deleted", async () => {
    const storage = createMemoryStorage() as MemoryStorageAdapter;

    await storage.upload("user/1/file.txt", Buffer.from("data"), {
      mimeType: "text/plain",
    });
    expect(await storage.exists("user/1/file.txt")).toBe(true);

    await storage.delete("user/1/file.txt");

    expect(await storage.exists("user/1/file.txt")).toBe(false);
    await expect(storage.download("user/1/file.txt")).rejects.toThrow(
      "File not found"
    );
  });

  it("removes all blobs when keys are deleted in bulk", async () => {
    const storage = createMemoryStorage() as MemoryStorageAdapter;

    await storage.upload("a.txt", Buffer.from("a"));
    await storage.upload("b.txt", Buffer.from("b"));

    await storage.deleteMany(["a.txt", "b.txt"]);

    expect(await storage.exists("a.txt")).toBe(false);
    expect(await storage.exists("b.txt")).toBe(false);
  });
});
