import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useFileResource } from "@/storage/resource";
import { createMemoryStorage } from "@/storage/memory";
import { rsql } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createCovara } from "@/server/app";
import { createTestApp } from "../helpers/hono";

const filesTable = sqliteTable("uf_files", {
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

const makeForm = (name: string, content: string, type = "text/plain"): FormData => {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type }));
  return fd;
};

describe("Unified file resource", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(async () => {
    clearSchemaRegistry();
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    db = drizzle(libsqlClient);
    storage = createMemoryStorage();
    await libsqlClient.execute(`
      CREATE TABLE uf_files (
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
    `);
  });

  afterEach(() => {
    libsqlClient.close();
    clearSchemaRegistry();
  });

  it("uploads via multipart, returns the raw record, and fires create hooks", async () => {
    const onAfterCreate = vi.fn();
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/files",
      useFileResource(filesTable, { db, id: filesTable.id, storage, hooks: { onAfterCreate } })
    );

    const res = await app.request("/files", { method: "POST", body: makeForm("a.txt", "hello") });
    expect(res.status).toBe(201);
    const body = await res.json();
    // No { data } envelope — raw record like a normal resource create.
    expect(body.data).toBeUndefined();
    expect(body.filename).toBe("a.txt");
    expect(body.status).toBe("completed");
    expect(body.size).toBe(5);
    expect(onAfterCreate).toHaveBeenCalledTimes(1);

    // The bytes are actually in storage.
    expect(await storage.exists(body.storagePath)).toBe(true);
  });

  it("accepts Drizzle column objects for fields.readable and masks correctly", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/files",
      useFileResource(filesTable, {
        db,
        id: filesTable.id,
        storage,
        fields: { readable: [filesTable.id, filesTable.filename, filesTable.status] },
      })
    );

    const up = await app.request("/files", { method: "POST", body: makeForm("a.txt", "hello") });
    expect(up.status).toBe(201);
    const created = await up.json();

    const res = await app.request(`/files/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe("a.txt");
    expect(body.id).toBe(created.id);
    // storagePath is not in the readable allowlist -> masked out.
    expect("storagePath" in body).toBe(false);
  });

  it("lists with the standard resource shape ({ items })", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/files", useFileResource(filesTable, { db, id: filesTable.id, storage }));
    await app.request("/files", { method: "POST", body: makeForm("a.txt", "x") });

    const res = await app.request("/files");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it("returns the raw record on GET /:id", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/files", useFileResource(filesTable, { db, id: filesTable.id, storage }));
    const created = await (await app.request("/files", { method: "POST", body: makeForm("a.txt", "x") })).json();

    const res = await app.request(`/files/${created.id}`);
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.id).toBe(created.id);
  });

  it("deletes the stored object on DELETE (storage cleanup + user onAfterDelete)", async () => {
    const onAfterDelete = vi.fn();
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/files",
      useFileResource(filesTable, { db, id: filesTable.id, storage, hooks: { onAfterDelete } })
    );
    const created = await (await app.request("/files", { method: "POST", body: makeForm("a.txt", "x") })).json();
    expect(await storage.exists(created.storagePath)).toBe(true);

    const del = await app.request(`/files/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await storage.exists(created.storagePath)).toBe(false);
    expect(onAfterDelete).toHaveBeenCalledTimes(1);
  });

  it("streams the file on /:id/download", async () => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route("/files", useFileResource(filesTable, { db, id: filesTable.id, storage }));
    const created = await (await app.request("/files", { method: "POST", body: makeForm("a.txt", "hello world") })).json();

    const res = await app.request(`/files/${created.id}/download`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
  });

  it("enforces the read scope on list (like a normal resource)", async () => {
    const u1App = createTestApp({ user: { id: "u1" } });
    u1App.route(
      "/files",
      useFileResource(filesTable, {
        db,
        id: filesTable.id,
        storage,
        auth: { read: async (u) => rsql`userId==${u.id}` },
      })
    );
    await u1App.request("/files", { method: "POST", body: makeForm("a.txt", "x") });

    const u2App = createTestApp({ user: { id: "u2" } });
    u2App.route(
      "/files",
      useFileResource(filesTable, {
        db,
        id: filesTable.id,
        storage,
        auth: { read: async (u) => rsql`userId==${u.id}` },
      })
    );
    const res = await u2App.request("/files");
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("chains via createCovara().fileResource()", async () => {
    const app = createCovara({ adminUI: false, openapi: false, health: false }).fileResource(
      "/files",
      filesTable,
      { db, id: filesTable.id, storage, auth: { public: { read: true } } }
    );
    const res = await app.request("/api/files");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});
