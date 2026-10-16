import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { MemoryStorageAdapter } from "@/storage/memory";
import { resetStorageMaintenanceState, sweepOrphanedBlobs } from "@/storage/cleanup";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { filesTable, otherFilesTable, mountFiles, NativeMultipartMemoryStorage, setupFilesDb, type FilesDb } from "./helpers";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

type App = ReturnType<typeof mountFiles>;

const createSession = async (app: App, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const res = await app.request("/files/uploads", {
    ...json(body),
    headers: { "content-type": "application/json", ...headers },
  });
  return res;
};

const putPart = (app: App, id: string, n: number | string, data: string | Buffer, headers: Record<string, string> = {}) =>
  app.request(`/files/uploads/${id}/parts/${n}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...headers },
    body: typeof data === "string" ? Buffer.from(data) : data,
  });

const complete = (app: App, id: string, headers: Record<string, string> = {}) =>
  app.request(`/files/uploads/${id}/complete`, { method: "POST", headers });

const status = (app: App, id: string, headers: Record<string, string> = {}) =>
  app.request(`/files/uploads/${id}`, { headers });

const chunks = (content: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out;
};

const small = { partSize: 4, minPartSize: 1, maxPartSize: 1024 };

describe("Resumable uploads", () => {
  let client: Awaited<ReturnType<typeof setupFilesDb>>["client"];
  let db: FilesDb;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    clearSchemaRegistry();
    resetStorageMaintenanceState();
    ({ client, db } = await setupFilesDb());
    storage = new MemoryStorageAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.close();
    resetStorageMaintenanceState();
  });

  const upload = async (app: App, content: string, extra: Record<string, unknown> = {}) => {
    const res = await createSession(app, { filename: "a.txt", size: Buffer.byteLength(content), contentType: "text/plain", ...extra });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ uploadId: string; partSize: number; partCount: number; uploadToken?: string; direct: boolean }>;
  };

  describe("generic fallback (memory adapter)", () => {
    it("uploads parts out of order, reports progress, and assembles on complete", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const content = "hello world!!";
      const session = await upload(app, content);
      expect(session.partSize).toBe(4);
      expect(session.partCount).toBe(4);
      const parts = chunks(content, 4);

      for (const n of [3, 1, 4]) expect((await putPart(app, session.uploadId, n, parts[n - 1])).status).toBe(200);
      const mid = await (await status(app, session.uploadId)).json();
      expect(mid.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1, 3, 4]);
      expect(mid.missingParts).toEqual([2]);
      expect(mid.receivedBytes).toBe(9);
      expect(mid.status).toBe("active");

      expect((await putPart(app, session.uploadId, 2, parts[1])).status).toBe(200);
      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(201);
      const file = await res.json();
      expect(file.size).toBe(13);
      expect(file.mimeType).toBe("text/plain");
      expect(file.status).toBe("completed");
      expect(file.userId).toBe("u1");

      const download = await app.request(`/files/${file.id}/download`);
      expect(await download.text()).toBe(content);
      expect(storage.getKeys()).toEqual([file.storagePath]);
    });

    it("treats duplicate part uploads idempotently (last write wins)", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(200);
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(200);
      expect((await putPart(app, session.uploadId, 1, "ABCD")).status).toBe(200);
      await putPart(app, session.uploadId, 2, "efgh");
      const st = await (await status(app, session.uploadId)).json();
      expect(st.parts).toHaveLength(2);
      const file = await (await complete(app, session.uploadId)).json();
      expect(await (await app.request(`/files/${file.id}/download`)).text()).toBe("ABCDefgh");
    });

    it("rejects parts with the wrong size (bigger than declared or truncated)", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefghij");
      expect((await putPart(app, session.uploadId, 1, "abcde")).status).toBe(413);
      expect((await putPart(app, session.uploadId, 1, "abc")).status).toBe(400);
      expect((await putPart(app, session.uploadId, 3, "ijk")).status).toBe(413);
      expect((await putPart(app, session.uploadId, 3, "i")).status).toBe(400);
      expect((await putPart(app, session.uploadId, 3, "ij")).status).toBe(200);
    });

    it("rejects invalid part numbers", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      for (const n of [0, 3, "abc", "1.5", -1]) {
        expect((await putPart(app, session.uploadId, n, "abcd")).status).toBe(400);
      }
    });

    it("refuses to complete with missing parts and lists them", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefghijklmnop");
      await putPart(app, session.uploadId, 1, "abcd");
      await putPart(app, session.uploadId, 3, "ijkl");
      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain("[2,4]");
      expect(await db.select().from(filesTable)).toHaveLength(0);
    });

    it("validates the session request", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small, maxFileSize: 10 });
      expect((await createSession(app, { filename: "a", size: 11 })).status).toBe(400);
      expect((await createSession(app, { filename: "a", size: -1 })).status).toBe(400);
      expect((await createSession(app, { filename: "a", size: 1.5 })).status).toBe(400);
      expect((await createSession(app, { size: 5 })).status).toBe(400);
      expect((await createSession(app, { filename: "a", size: 5, checksum: { algorithm: "md5", value: "x" } })).status).toBe(400);
      expect((await createSession(app, { filename: "a", size: 10 })).status).toBe(201);
    });

    it("clamps the requested part size and raises it to respect maxParts", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, {
        resumable: { partSize: 4, minPartSize: 2, maxPartSize: 16, maxParts: 10 },
      });
      const clampedLow = await (await createSession(app, { filename: "a", size: 8, partSize: 1 })).json();
      expect(clampedLow.partSize).toBe(2);
      const clampedHigh = await (await createSession(app, { filename: "a", size: 8, partSize: 999 })).json();
      expect(clampedHigh.partSize).toBe(16);
      const raised = await (await createSession(app, { filename: "a", size: 100 })).json();
      expect(raised.partSize).toBe(10);
      expect(raised.partCount).toBe(10);
      expect((await createSession(app, { filename: "a", size: 1000 })).status).toBe(400);
    });

    it("does not let another user resume, inspect, complete or abort my session", async () => {
      const mine = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const theirs = mountFiles(db, storage, { id: "u2" }, { resumable: small });
      const session = await upload(mine, "abcd");
      expect((await status(theirs, session.uploadId)).status).toBe(404);
      expect((await putPart(theirs, session.uploadId, 1, "abcd")).status).toBe(404);
      expect((await complete(theirs, session.uploadId)).status).toBe(404);
      expect((await theirs.request(`/files/uploads/${session.uploadId}`, { method: "DELETE" })).status).toBe(404);
      expect((await status(mine, session.uploadId)).status).toBe(200);
    });

    it("requires the upload token for anonymous sessions", async () => {
      const app = mountFiles(db, storage, null, { resumable: small, auth: { public: { create: true, read: true } } });
      const session = await upload(app, "abcd");
      expect(typeof session.uploadToken).toBe("string");
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(404);
      expect((await putPart(app, session.uploadId, 1, "abcd", { "covara-upload-token": "wrong" })).status).toBe(404);
      const auth = { "covara-upload-token": session.uploadToken! };
      expect((await putPart(app, session.uploadId, 1, "abcd", auth)).status).toBe(200);
      expect((await complete(app, session.uploadId, auth)).status).toBe(201);
    });

    it("expires sessions after their TTL", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: { ...small, sessionTtlSeconds: 60 } });
      const session = await upload(app, "abcd");
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 1000);
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(410);
      expect((await status(app, session.uploadId)).status).toBe(410);
      expect((await complete(app, session.uploadId)).status).toBe(410);
    });

    it("cannot be resumed after abort, and abort removes stored parts", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      expect(storage.getKeys().length).toBe(1);
      const res = await app.request(`/files/uploads/${session.uploadId}`, { method: "DELETE" });
      expect(res.status).toBe(204);
      expect(storage.getKeys()).toEqual([]);
      expect((await putPart(app, session.uploadId, 2, "efgh")).status).toBe(404);
      expect((await status(app, session.uploadId)).status).toBe(404);
      expect((await complete(app, session.uploadId)).status).toBe(404);
    });

    it("sniffs the first part and aborts the session on a dangerous mismatch", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: { ...small, partSize: 16 } });
      const content = "<html><script>alert(1)</script></html>";
      const session = await upload(app, content, { contentType: "image/png", filename: "x.png" });
      expect((await putPart(app, session.uploadId, 2, content.slice(16, 32))).status).toBe(200);
      const res = await putPart(app, session.uploadId, 1, content.slice(0, 16));
      expect(res.status).toBe(400);
      expect((await status(app, session.uploadId)).status).toBe(404);
      expect(storage.getKeys()).toEqual([]);
    });

    it("applies allowedMimeTypes to the sniffed first part", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small, allowedMimeTypes: ["image/png"] });
      const session = await upload(app, "abcdefgh", { contentType: "text/plain" });
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(400);
      expect((await status(app, session.uploadId)).status).toBe(404);
    });

    it("supports zero-byte files", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "");
      expect(session.partCount).toBe(0);
      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(201);
      const file = await res.json();
      expect(file.size).toBe(0);
      expect(file.mimeType).toBe("text/plain");
    });

    it("rejects a zero-byte file declared as an image", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "", { contentType: "image/png" });
      expect((await complete(app, session.uploadId)).status).toBe(400);
      expect(storage.getKeys()).toEqual([]);
    });

    it("makes complete idempotent", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcd");
      await putPart(app, session.uploadId, 1, "abcd");
      const first = await complete(app, session.uploadId);
      expect(first.status).toBe(201);
      const second = await complete(app, session.uploadId);
      expect(second.status).toBe(200);
      expect((await second.json()).id).toBe((await first.json()).id);
      expect(await db.select().from(filesTable)).toHaveLength(1);
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(409);
    });

    it("serialises concurrent completes into a single file", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      await putPart(app, session.uploadId, 2, "efgh");
      const results = await Promise.all([complete(app, session.uploadId), complete(app, session.uploadId)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(201);
      expect([200, 409]).toContain(statuses[1]);
      expect(await db.select().from(filesTable)).toHaveLength(1);
    });

    it("verifies a whole-file sha256 checksum", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const bad = await upload(app, "abcd", { checksum: { algorithm: "sha256", value: sha256("zzzz") } });
      await putPart(app, bad.uploadId, 1, "abcd");
      expect((await complete(app, bad.uploadId)).status).toBe(400);
      expect(await db.select().from(filesTable)).toHaveLength(0);
      expect(storage.getKeys()).toEqual([]);
      expect((await (await status(app, bad.uploadId)).json()).status).toBe("failed");

      const good = await upload(app, "abcd", { checksum: { algorithm: "sha256", value: sha256("abcd") } });
      await putPart(app, good.uploadId, 1, "abcd");
      expect((await complete(app, good.uploadId)).status).toBe(201);
    });

    it("verifies a per-part sha256 header", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcd");
      expect((await putPart(app, session.uploadId, 1, "abcd", { "covara-part-sha256": sha256("nope") })).status).toBe(400);
      expect((await putPart(app, session.uploadId, 1, "abcd", { "covara-part-sha256": sha256("abcd") })).status).toBe(200);
    });

    it("recovers when the row insert fails after assembly (retry complete)", async () => {
      let fail = true;
      const app = mountFiles(db, storage, { id: "u1" }, {
        resumable: small,
        hooks: {
          onBeforeCreate: async () => {
            if (fail) {
              fail = false;
              throw new Error("transient");
            }
          },
        },
      });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      await putPart(app, session.uploadId, 2, "efgh");
      expect((await complete(app, session.uploadId)).status).toBe(500);
      const retry = await complete(app, session.uploadId);
      expect(retry.status).toBe(201);
      const file = await retry.json();
      expect(await (await app.request(`/files/${file.id}/download`)).text()).toBe("abcdefgh");
      expect(storage.getKeys()).toEqual([file.storagePath]);
    });

    it("asks for a re-upload when a stored part object has vanished", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      await putPart(app, session.uploadId, 2, "efgh");
      const partKey = storage.getKeys().find((k) => k.endsWith(`${session.uploadId}/2`))!;
      await storage.delete(partKey);

      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(409);
      const st = await (await status(app, session.uploadId)).json();
      expect(st.status).toBe("active");
      expect(st.missingParts).toEqual([2]);

      await putPart(app, session.uploadId, 2, "efgh");
      const done = await complete(app, session.uploadId);
      expect(done.status).toBe(201);
    });

    it("does not let a session be used through a different file resource", async () => {
      const files = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const other = mountFiles(db, storage, { id: "u1" }, { resumable: small }, otherFilesTable);
      const session = await upload(files, "abcd");
      expect((await putPart(other, session.uploadId, 1, "abcd")).status).toBe(404);
      expect((await complete(other, session.uploadId)).status).toBe(404);
    });

    it("rejects part uploads to a failed session", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcd", { checksum: { algorithm: "sha256", value: sha256("nope") } });
      await putPart(app, session.uploadId, 1, "abcd");
      expect((await complete(app, session.uploadId)).status).toBe(400);
      expect((await putPart(app, session.uploadId, 1, "abcd")).status).toBe(409);
      expect((await complete(app, session.uploadId)).status).toBe(409);
    });

    it("returns 404 when resumable uploads are disabled", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: false });
      expect((await createSession(app, { filename: "a", size: 1 })).status).toBe(404);
    });

    it("lets the sweeper clean up expired sessions and their parts", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: { ...small, sessionTtlSeconds: 60 } });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      expect(storage.getKeys()).toHaveLength(1);

      const early = await sweepOrphanedBlobs({ graceMs: 0 });
      expect(early.sessionsExpired).toBe(0);
      expect(storage.getKeys()).toHaveLength(1);

      const result = await sweepOrphanedBlobs({ graceMs: 0, now: Date.now() + 10 * 60 * 1000 });
      expect(result.sessionsExpired).toBe(1);
      expect(storage.getKeys()).toEqual([]);
    });
  });

  describe("native multipart adapters", () => {
    let native: NativeMultipartMemoryStorage;
    beforeEach(() => {
      native = new NativeMultipartMemoryStorage();
    });

    it("uses the adapter's multipart API instead of the generic fallback", async () => {
      const app = mountFiles(db, native, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefghij");
      await putPart(app, session.uploadId, 2, "efgh");
      await putPart(app, session.uploadId, 1, "abcd");
      await putPart(app, session.uploadId, 3, "ij");
      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(201);
      const file = await res.json();
      expect(native.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
      expect(native.calls).toContain(`complete:${file.storagePath}`);
      expect(native.getKeys()).toEqual([file.storagePath]);
      expect((await native.download(file.storagePath)).toString()).toBe("abcdefghij");
    });

    it("aborts the native upload on abort", async () => {
      const app = mountFiles(db, native, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh");
      await putPart(app, session.uploadId, 1, "abcd");
      await app.request(`/files/uploads/${session.uploadId}`, { method: "DELETE" });
      expect(native.calls.some((c) => c.startsWith("abort:"))).toBe(true);
      expect(native.uploads.size).toBe(0);
    });

    it("respects adapter multipart limits (minimum part size)", async () => {
      native.multipartLimits = { minPartSize: 8, maxPartSize: 64, maxParts: 100 };
      const app = mountFiles(db, native, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefghijklmnop");
      expect(session.partSize).toBe(8);
    });

    it("hands out presigned part URLs in direct mode and verifies on complete", async () => {
      const app = mountFiles(db, native, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh", { direct: true });
      expect(session.direct).toBe(true);
      const urlRes = await app.request(`/files/uploads/${session.uploadId}/parts/1/url`);
      expect(urlRes.status).toBe(200);
      expect((await urlRes.json()).url).toMatch(/partNumber=1/);

      const nativeId = [...native.uploads.keys()][0];
      native.directPut(nativeId, 1, Buffer.from("abcd"));
      const mid = await (await status(app, session.uploadId)).json();
      expect(mid.missingParts).toEqual([2]);
      native.directPut(nativeId, 2, Buffer.from("efgh"));

      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(201);
      expect((await res.json()).size).toBe(8);
    });

    it("rejects and deletes a direct upload whose content is dangerous", async () => {
      const app = mountFiles(db, native, { id: "u1" }, { resumable: { ...small, partSize: 16 } });
      const content = "<html><script>alert(1)</script>";
      const session = await upload(app, content, { direct: true, contentType: "image/png" });
      const nativeId = [...native.uploads.keys()][0];
      native.directPut(nativeId, 1, Buffer.from(content.slice(0, 16)));
      native.directPut(nativeId, 2, Buffer.from(content.slice(16)));
      const res = await complete(app, session.uploadId);
      expect(res.status).toBe(400);
      expect(native.getKeys()).toEqual([]);
      expect(await db.select().from(filesTable)).toHaveLength(0);
    });

    it("rejects direct mode parts with the wrong size on complete", async () => {
      const app = mountFiles(db, native, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcdefgh", { direct: true });
      const nativeId = [...native.uploads.keys()][0];
      native.directPut(nativeId, 1, Buffer.from("abcdXX"));
      native.directPut(nativeId, 2, Buffer.from("efgh"));
      expect((await complete(app, session.uploadId)).status).toBe(400);
    });

    it("falls back to proxied mode when the adapter cannot presign parts", async () => {
      const app = mountFiles(db, storage, { id: "u1" }, { resumable: small });
      const session = await upload(app, "abcd", { direct: true });
      expect(session.direct).toBe(false);
    });
  });
});
