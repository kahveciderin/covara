import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { MemoryStorageAdapter } from "@/storage/memory";
import {
  drainBlobDeletions,
  enqueueBlobDeletion,
  getBlobDeletionStats,
  sweepOrphanedBlobs,
  runStorageMaintenance,
  resetStorageMaintenanceState,
} from "@/storage/cleanup";
import { clearGlobalKV, setGlobalKV } from "@/kv/types";
import { createMemoryKV } from "@/kv/memory";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import {
  filesTable,
  otherFilesTable,
  FlakyDeleteStorage,
  form,
  mountFiles,
  PresignedMemoryStorage,
  setupFilesDb,
  type FilesDb,
} from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("Durable blob deletion", () => {
  let client: Awaited<ReturnType<typeof setupFilesDb>>["client"];
  let db: FilesDb;
  let storage: FlakyDeleteStorage;

  beforeEach(async () => {
    clearSchemaRegistry();
    resetStorageMaintenanceState();
    ({ client, db } = await setupFilesDb());
    storage = new FlakyDeleteStorage();
  });

  afterEach(() => {
    client.close();
    clearGlobalKV();
    resetStorageMaintenanceState();
  });

  const create = async (app: ReturnType<typeof mountFiles>, name = "a.txt", content = "hello") => {
    const res = await app.request("/files", { method: "POST", body: form(name, content) });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ id: string; storagePath: string }>;
  };

  it("deletes the blob and leaves no tombstone on a healthy delete", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    const res = await app.request(`/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await storage.exists(file.storagePath)).toBe(false);
    expect(await getBlobDeletionStats()).toEqual({ pending: 0, dead: 0 });
  });

  it("keeps a retryable tombstone when the storage delete fails, and the drainer finishes it", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    storage.failDeletes = 1;

    const res = await app.request(`/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await db.select().from(filesTable)).toHaveLength(0);
    expect(await storage.exists(file.storagePath)).toBe(true);
    expect((await getBlobDeletionStats()).pending).toBe(1);

    const result = await drainBlobDeletions({}, Date.now() + HOUR);
    expect(result.deleted).toBe(1);
    expect(await storage.exists(file.storagePath)).toBe(false);
    expect(await getBlobDeletionStats()).toEqual({ pending: 0, dead: 0 });
  });

  it("backs off between attempts and parks exhausted tombstones in the dead set", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    storage.failDeletes = 100;
    await app.request(`/files/${file.id}`, { method: "DELETE" });

    const start = Date.now();
    const calls = storage.deleteCalls;
    const early = await drainBlobDeletions({ backoffBaseMs: 1000, maxAttempts: 3 }, start);
    expect(early.processed).toBe(0);
    expect(storage.deleteCalls).toBe(calls);

    await drainBlobDeletions({ backoffBaseMs: 1000, maxAttempts: 3 }, start + HOUR);
    await drainBlobDeletions({ backoffBaseMs: 1000, maxAttempts: 3 }, start + 2 * HOUR);
    expect(await getBlobDeletionStats()).toEqual({ pending: 0, dead: 1 });
    expect(await storage.exists(file.storagePath)).toBe(true);
  });

  it("drops a prepared tombstone when the row delete never happened (crash before row delete)", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    await enqueueBlobDeletion("sf_files", file.storagePath, { phase: "prepared" });

    const early = await drainBlobDeletions({}, Date.now());
    expect(early.processed).toBe(0);

    const later = await drainBlobDeletions({}, Date.now() + HOUR);
    expect(later.dropped).toBe(1);
    expect(await storage.exists(file.storagePath)).toBe(true);
    expect((await getBlobDeletionStats()).pending).toBe(0);
  });

  it("aborts the delete (row kept, nothing orphaned) when the tombstone cannot be written first", async () => {
    const kv = createMemoryKV();
    setGlobalKV(kv);
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    const original = kv.hset.bind(kv);
    kv.hset = async () => {
      throw new Error("kv down");
    };
    const res = await app.request(`/files/${file.id}`, { method: "DELETE" });
    kv.hset = original;
    expect(res.status).toBe(500);
    expect(await db.select().from(filesTable)).toHaveLength(1);
    expect(await storage.exists(file.storagePath)).toBe(true);
  });

  it("finishes a prepared tombstone whose row is gone (crash between row delete and blob delete)", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    await enqueueBlobDeletion("sf_files", file.storagePath, { phase: "prepared" });
    await db.delete(filesTable).where(eq(filesTable.id, file.id));

    const result = await drainBlobDeletions({}, Date.now() + HOUR);
    expect(result.deleted).toBe(1);
    expect(await storage.exists(file.storagePath)).toBe(false);
  });

  it("never deletes a blob that is still referenced by a row", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    const [row] = await db.select().from(filesTable).where(eq(filesTable.id, file.id));
    await db.insert(filesTable).values({ ...row, id: "copy" });

    const res = await app.request(`/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await storage.exists(file.storagePath)).toBe(true);
    await drainBlobDeletions({}, Date.now() + DAY);
    expect(await storage.exists(file.storagePath)).toBe(true);
    expect((await getBlobDeletionStats()).pending).toBe(0);
  });

  it("handles concurrent deletes of the same file", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    const statuses = (
      await Promise.all([
        app.request(`/files/${file.id}`, { method: "DELETE" }),
        app.request(`/files/${file.id}`, { method: "DELETE" }),
      ])
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 204).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 204 || s === 404)).toBe(true);
    expect(await storage.exists(file.storagePath)).toBe(false);
    expect(await getBlobDeletionStats()).toEqual({ pending: 0, dead: 0 });
  });

  it("batch delete removes rows first and retries failed blob deletes", async () => {
    const app = mountFiles(db, storage, { id: "u1" });
    const a = await create(app, "a.txt");
    const b = await create(app, "b.txt");
    storage.failDeletes = 2;

    const res = await app.request("/files/batch", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(await db.select().from(filesTable)).toHaveLength(0);
    expect((await getBlobDeletionStats()).pending).toBe(2);

    await drainBlobDeletions({}, Date.now() + HOUR);
    expect(await storage.exists(a.storagePath)).toBe(false);
    expect(await storage.exists(b.storagePath)).toBe(false);
  });

  it("removes the uploaded blob when the row insert fails", async () => {
    const app = mountFiles(db, storage, { id: "u1" }, {
      hooks: {
        onBeforeCreate: async () => {
          throw new Error("hook rejected");
        },
      },
    });
    const res = await app.request("/files", { method: "POST", body: form("a.txt", "x") });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storage.getKeys()).toHaveLength(0);
  });

  it("persists tombstones in the global KV when one is configured", async () => {
    const kv = createMemoryKV();
    setGlobalKV(kv);
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await create(app);
    storage.failDeletes = 1;
    await app.request(`/files/${file.id}`, { method: "DELETE" });
    expect(await kv.smembers("covara:storage:blobdel:pending")).toHaveLength(1);
    await drainBlobDeletions({}, Date.now() + HOUR);
    expect(await kv.smembers("covara:storage:blobdel:pending")).toHaveLength(0);
  });
});

describe("sweepOrphanedBlobs", () => {
  let client: Awaited<ReturnType<typeof setupFilesDb>>["client"];
  let db: FilesDb;

  beforeEach(async () => {
    clearSchemaRegistry();
    resetStorageMaintenanceState();
    ({ client, db } = await setupFilesDb());
  });

  afterEach(() => {
    client.close();
    resetStorageMaintenanceState();
  });

  it("deletes unreferenced blobs older than the grace period and keeps everything else", async () => {
    const storage = new MemoryStorageAdapter();
    const app = mountFiles(db, storage, { id: "u1" });
    const kept = await (await app.request("/files", { method: "POST", body: form("keep.txt", "k") })).json();
    await storage.upload("orphan-old.txt", Buffer.from("o"));

    const fresh = await sweepOrphanedBlobs({ graceMs: DAY });
    expect(fresh.orphansDeleted).toEqual([]);

    const result = await sweepOrphanedBlobs({ graceMs: DAY, now: Date.now() + 2 * DAY });
    expect(result.orphansDeleted).toEqual(["orphan-old.txt"]);
    expect(await storage.exists("orphan-old.txt")).toBe(false);
    expect(await storage.exists(kept.storagePath)).toBe(true);
  });

  it("keeps blobs referenced by another file resource sharing the same storage", async () => {
    const storage = new MemoryStorageAdapter();
    mountFiles(db, storage, { id: "u1" });
    const other = mountFiles(db, storage, { id: "u1" }, {}, otherFilesTable);
    const file = await (await other.request("/files", { method: "POST", body: form("o.txt", "o") })).json();

    const result = await sweepOrphanedBlobs({ graceMs: 0, now: Date.now() + DAY });
    expect(result.orphansDeleted).toEqual([]);
    expect(await storage.exists(file.storagePath)).toBe(true);
  });

  it("only scans under the resource keyPrefix", async () => {
    const storage = new MemoryStorageAdapter();
    const app = mountFiles(db, storage, { id: "u1" }, { keyPrefix: "uploads/" });
    const file = await (await app.request("/files", { method: "POST", body: form("a.txt", "a") })).json();
    expect(file.storagePath.startsWith("uploads/")).toBe(true);
    await storage.upload("unrelated/data.bin", Buffer.from("x"));
    await storage.upload("uploads/orphan.txt", Buffer.from("x"));

    const result = await sweepOrphanedBlobs({ graceMs: 0, now: Date.now() + DAY });
    expect(result.orphansDeleted).toEqual(["uploads/orphan.txt"]);
    expect(await storage.exists("unrelated/data.bin")).toBe(true);
  });

  it("cleans abandoned pending presigned uploads (row + object) past their TTL", async () => {
    const storage = new PresignedMemoryStorage();
    const app = mountFiles(db, storage, { id: "u1" });
    const started = await (await app.request("/files/upload-url?filename=a.png&contentType=image/png")).json();
    await storage.upload(started.key, Buffer.from("partial"));

    const early = await sweepOrphanedBlobs({ pendingUploadTtlMs: DAY });
    expect(early.pendingRowsDeleted).toBe(0);

    const result = await sweepOrphanedBlobs({ pendingUploadTtlMs: DAY, now: Date.now() + 2 * DAY });
    expect(result.pendingRowsDeleted).toBe(1);
    expect(await storage.exists(started.key)).toBe(false);
    expect(await db.select().from(filesTable)).toHaveLength(0);
  });

  it("dry runs report without deleting", async () => {
    const storage = new MemoryStorageAdapter();
    mountFiles(db, storage, { id: "u1" });
    await storage.upload("orphan.txt", Buffer.from("o"));
    const result = await sweepOrphanedBlobs({ graceMs: 0, now: Date.now() + DAY, dryRun: true });
    expect(result.orphansDeleted).toEqual(["orphan.txt"]);
    expect(await storage.exists("orphan.txt")).toBe(true);
  });

  it("skips the orphan scan for adapters that cannot list", async () => {
    const storage = new MemoryStorageAdapter();
    (storage as unknown as { list?: unknown }).list = undefined;
    mountFiles(db, storage, { id: "u1" });
    await storage.upload("orphan.txt", Buffer.from("o"));
    const result = await sweepOrphanedBlobs({ graceMs: 0, now: Date.now() + DAY });
    expect(result.orphansDeleted).toEqual([]);
    expect(result.unlistable).toBe(1);
  });

  it("runStorageMaintenance drains tombstones and sweeps in one call", async () => {
    const storage = new FlakyDeleteStorage();
    const app = mountFiles(db, storage, { id: "u1" });
    const file = await (await app.request("/files", { method: "POST", body: form("a.txt", "a") })).json();
    storage.failDeletes = 1;
    await app.request(`/files/${file.id}`, { method: "DELETE" });
    await storage.upload("orphan.txt", Buffer.from("o"));

    const result = await runStorageMaintenance({ graceMs: 0, now: Date.now() + DAY });
    expect(result.deletions.deleted).toBe(1);
    expect(result.sweep.orphansDeleted).toEqual(["orphan.txt"]);
    expect(storage.getKeys()).toHaveLength(0);
  });
});
