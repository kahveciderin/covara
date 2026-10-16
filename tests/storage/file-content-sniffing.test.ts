import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { MemoryStorageAdapter } from "@/storage/memory";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { fixtures, pngBytes } from "./fixtures";
import {
  filesTable,
  form,
  mountFiles,
  PresignedMemoryStorage,
  setupFilesDb,
  type FilesDb,
} from "./helpers";

describe("File resource content sniffing", () => {
  let client: Awaited<ReturnType<typeof setupFilesDb>>["client"];
  let db: FilesDb;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    clearSchemaRegistry();
    ({ client, db } = await setupFilesDb());
    storage = new MemoryStorageAdapter();
  });

  afterEach(() => {
    client.close();
  });

  const upload = (app: ReturnType<typeof mountFiles>, fd: FormData) =>
    app.request("/files", { method: "POST", body: fd });

  describe("multipart uploads (enforce, default)", () => {
    it("stores the sniffed type for a matching upload", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("cat.png", pngBytes(), "image/png"));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.mimeType).toBe("image/png");
    });

    it("rejects HTML disguised as a PNG and stores nothing", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("cat.png", "<html><script>alert(1)</script></html>", "image/png"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/does not match/);
      expect(storage.getKeys()).toHaveLength(0);
      expect(await db.select().from(filesTable)).toHaveLength(0);
    });

    it("rejects SVG with an image/png declared type", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("x.png", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "image/png"));
      expect(res.status).toBe(400);
    });

    it("applies allowedMimeTypes to the sniffed type, not the declared one", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { allowedMimeTypes: ["image/png"] });
      const spoofed = await upload(app, form("a.png", "<html></html>", "image/png"));
      expect(spoofed.status).toBe(400);

      const mislabelled = await upload(app, form("a.bin", pngBytes(), "application/octet-stream"));
      expect(mislabelled.status).toBe(201);
      expect((await mislabelled.json()).mimeType).toBe("image/png");
    });

    it("applies validation.allowedTypes wildcards to the sniffed type", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { validation: { allowedTypes: ["image/*"] } });
      const res = await upload(app, form("evil.jpg", "<!doctype html><p>x", "image/jpeg"));
      expect(res.status).toBe(400);
      const ok = await upload(app, form("ok.jpg", Buffer.from(fixtures.jpeg), "image/jpeg"));
      expect(ok.status).toBe(201);
    });

    it("rejects a zero-byte file declared as an image but accepts empty text", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      expect((await upload(app, form("empty.png", "", "image/png"))).status).toBe(400);
      const text = await upload(app, form("empty.txt", "", "text/plain"));
      expect(text.status).toBe(201);
      const body = await text.json();
      expect(body.size).toBe(0);
      expect(body.mimeType).toBe("text/plain");
    });

    it("rejects a truncated PNG signature", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("t.png", fixtures.png.subarray(0, 4), "image/png"));
      expect(res.status).toBe(400);
    });

    it("rejects GIF/script polyglots", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const polyglot = Buffer.concat([Buffer.from(fixtures.gif), Buffer.from("<script>alert(document.cookie)</script>")]);
      const res = await upload(app, form("p.gif", polyglot, "image/gif"));
      expect(res.status).toBe(400);
    });

    it("rejects a spoofed extension when the browser derives the type from it", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("invoice.pdf", "<html><body>phish</body></html>", "application/pdf"));
      expect(res.status).toBe(400);
    });

    it("keeps a specific declared zip-container type (docx)", async () => {
      const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const app = mountFiles(db, storage, { id: "u1" });
      const res = await upload(app, form("a.docx", Buffer.from(fixtures.zip), docx));
      expect(res.status).toBe(201);
      expect((await res.json()).mimeType).toBe(docx);
    });

    it("trust-declared keeps the legacy behaviour", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { contentSniffing: "trust-declared" });
      const res = await upload(app, form("a.png", "<html></html>", "image/png"));
      expect(res.status).toBe(201);
      expect((await res.json()).mimeType).toBe("image/png");
    });

    it("lenient stores the sniffed type without rejecting", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { contentSniffing: "lenient" });
      const res = await upload(app, form("a.png", "<html></html>", "image/png"));
      expect(res.status).toBe(201);
      expect((await res.json()).mimeType).toBe("text/html");
    });
  });

  describe("downloads", () => {
    it("always sends nosniff, a sandbox CSP and an attachment disposition", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const created = await (await upload(app, form("cat.png", pngBytes(), "image/png"))).json();
      const res = await app.request(`/files/${created.id}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    });

    it("serves active content (html/svg) as application/octet-stream", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const created = await (await upload(app, form("page.html", "<html><script>1</script></html>", "text/html"))).json();
      expect(created.mimeType).toBe("text/html");
      const res = await app.request(`/files/${created.id}/download`);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("encodes hostile filenames safely in Content-Disposition", async () => {
      const app = mountFiles(db, storage, { id: "u1" });
      const created = await (await upload(app, form('a"b\r\nX-Evil: 1;ü.txt', "hi", "text/plain"))).json();
      const res = await app.request(`/files/${created.id}/download`);
      const cd = res.headers.get("content-disposition")!;
      expect(cd).not.toMatch(/[\r\n]/);
      expect(cd).toMatch(/filename\*=UTF-8''/);
      expect(res.headers.get("x-evil")).toBeNull();
      const asciiPart = /filename="([^"]*)"/.exec(cd)![1];
      expect(asciiPart).not.toContain('"');
    });

    it("passes safe response overrides to presigned download redirects", async () => {
      const presigned = new PresignedMemoryStorage();
      const app = mountFiles(db, presigned, { id: "u1" }, { usePresignedUrls: true });
      const created = await (await upload(app, form("x.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"))).json();
      const res = await app.request(`/files/${created.id}/download`);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("ct")).toBe("application/octet-stream");
      expect(location.searchParams.get("cd")).toMatch(/^attachment;/);
    });
  });

  describe("presigned uploads", () => {
    let presigned: PresignedMemoryStorage;
    beforeEach(() => {
      presigned = new PresignedMemoryStorage();
    });

    const startPresigned = async (app: ReturnType<typeof mountFiles>, filename: string, contentType: string) => {
      const res = await app.request(`/files/upload-url?filename=${encodeURIComponent(filename)}&contentType=${encodeURIComponent(contentType)}`);
      expect(res.status).toBe(200);
      return res.json() as Promise<{ fileId: string; key: string }>;
    };

    it("confirms a matching upload with the sniffed type", async () => {
      const app = mountFiles(db, presigned, { id: "u1" });
      const { fileId, key } = await startPresigned(app, "a.png", "image/png");
      await presigned.upload(key, pngBytes(), { mimeType: "image/png" });
      const res = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
      expect(body.mimeType).toBe("image/png");
      expect(body.size).toBe(64);
    });

    it("marks a mismatched upload rejected and deletes the object", async () => {
      const app = mountFiles(db, presigned, { id: "u1" });
      const { fileId, key } = await startPresigned(app, "a.png", "image/png");
      await presigned.upload(key, Buffer.from("<html><script>x</script></html>"), { mimeType: "image/png" });

      const res = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(await presigned.exists(key)).toBe(false);
      const [row] = await db.select().from(filesTable).where(eq(filesTable.id, fileId));
      expect(row.status).toBe("rejected");

      const again = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(again.status).toBe(400);
      const download = await app.request(`/files/${fileId}/download`);
      expect(download.status).toBe(400);
    });

    it("enforces allowedMimeTypes on the sniffed type at confirm time", async () => {
      const app = mountFiles(db, presigned, { id: "u1" }, { allowedMimeTypes: ["image/png", "application/octet-stream"] });
      const { fileId, key } = await startPresigned(app, "a.bin", "application/octet-stream");
      await presigned.upload(key, Buffer.from(fixtures.pdf));
      const res = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(await presigned.exists(key)).toBe(false);
    });

    it("enforces maxFileSize at confirm time", async () => {
      const app = mountFiles(db, presigned, { id: "u1" }, { maxFileSize: 10 });
      const { fileId, key } = await startPresigned(app, "a.txt", "text/plain");
      await presigned.upload(key, Buffer.from("this is longer than ten bytes"));
      const res = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(await presigned.exists(key)).toBe(false);
    });

    it("returns 404 when confirming before the object exists", async () => {
      const app = mountFiles(db, presigned, { id: "u1" });
      const { fileId } = await startPresigned(app, "a.png", "image/png");
      const res = await app.request(`/files/${fileId}/confirm`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});
