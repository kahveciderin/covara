---
id: storage
title: File storage
sidebar_label: Storage
description: File uploads as first-class resources — local/S3/R2/in-memory adapters, useFileResource endpoints, MIME and size validation, presigned URLs, orphan cleanup, and client hooks.
---

# File storage

A file resource **is a regular [resource](../core/resources-and-app.md)** plus an upload/download layer. It gives you everything `useResource` does — cursor-paginated list, single get, update, delete, [subscriptions](../realtime/subscriptions.md), [RPC procedures](../core/procedures.md), [lifecycle hooks](../core/procedures.md), [relations](../core/relations.md), [field policies](../core/fields.md), and full [auth scopes](../auth/scopes.md) — and adds `upload`, `upload-url`, `confirm`, and `download` endpoints, all behind one `StorageAdapter` (local disk, S3, Cloudflare R2, or memory).

## Quick start

```typescript
import { createCovara, initializeStorage, rsql } from "covara";

initializeStorage({ type: "local", local: { basePath: "./uploads", baseUrl: "/uploads" } });

const app = createCovara({ cors: true })
  .resource("/todos", todosTable, { id: todosTable.id, db })
  // Chains like any other resource:
  .fileResource("/files", filesTable, {
    id: filesTable.id,
    db,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/gif"],
    maxFileSize: 5 * 1024 * 1024,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      delete: async (user) => rsql`userId==${user?.id}`,
    },
  });
```

Local uploads are **served automatically** at the storage `baseUrl` (here `/uploads`) — `createCovara` mounts static serving for a local adapter with a `baseUrl`, so you no longer wire `serveStatic` by hand. (Opt out with `createCovara({ serveLocalStorage: false })`; on Workers use R2 and presigned URLs.) You can still mount `useFileResource(table, config)` manually with `app.route(...)` if you prefer.

## Adapters

| Adapter | `type` | Notes |
|---------|--------|-------|
| Local disk | `local` | Dev/simple deploys. Nested dirs, `.meta.json` sidecars, direct URLs. No presigned URLs. |
| S3 / compatible | `s3` | AWS S3, MinIO, DigitalOcean Spaces. Presigned URLs, multipart. |
| Cloudflare R2 | `r2` | Recommended on Workers. Binding mode or S3-compat mode. |
| Memory | `memory` | Tests; not persisted. |

```typescript
// S3
initializeStorage({
  type: "s3",
  s3: { bucket: "my-bucket", region: "us-east-1", accessKeyId: "...", secretAccessKey: "...", presignedUrlExpiry: 3600 },
});

// S3-compatible (MinIO, Spaces)
initializeStorage({
  type: "s3",
  s3: { bucket: "my-bucket", endpoint: "https://minio.example.com", forcePathStyle: true, accessKeyId: "...", secretAccessKey: "..." },
});

// R2 binding (inside a Worker)
initializeStorage({ type: "r2", r2: { binding: env.MY_BUCKET, publicUrl: "https://cdn.example.com" } });

// R2 via S3-compatible API (anywhere)
initializeStorage({
  type: "r2",
  r2: { accountId: env.R2_ACCOUNT_ID, bucket: "my-bucket", accessKeyId: "...", secretAccessKey: "...", presignedUrlExpiry: 3600 },
});
```

`createR2Adapter(config)` builds the adapter directly — a `binding` selects bindings mode (streams through the Worker), otherwise S3-compatible credentials enable presigned upload/download. On Workers, prefer R2 — there is no local filesystem. See [Workers deployment](../deployment/workers.md).

## Schema

```typescript
export const filesTable = sqliteTable("files", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => usersTable.id),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
```

## Configuration

`FileResourceConfig` is a **superset of [`ResourceConfig`](../core/resources-and-app.md)** — every regular-resource option (`hooks`, `procedures`, `relations`, `autoRelations`, `fields`, `capabilities`, `auth` as a full scope config with `read`/`create`/`update`/`delete`/`subscribe`/`public`, etc.) plus the storage options below:

```typescript
.fileResource("/files", filesTable, {
  db, id: filesTable.id,
  storage: adapter,                 // override the global adapter
  allowedMimeTypes: ["image/jpeg", "image/png"],
  maxFileSize: 5 * 1024 * 1024,
  validation: { maxSize: 5 * 1024 * 1024, allowedTypes: ["image/jpeg"], blockedTypes: ["application/x-msdownload"] },
  usePresignedUrls: false,
  presignedUrlExpiry: 3600,
  generateKey: (filename, userId) => `${userId}/${Date.now()}-${filename}`,
  auth: { /* full scope config: read/create/update/delete/subscribe/public */ },
  hooks: { onAfterCreate: async (ctx, file) => { /* runs after upload */ } },
  relations: { owner: { resource: "users", schema: usersTable, type: "belongsTo", foreignKey: filesTable.userId, references: usersTable.id } },
});
```

**Validation** runs before any bytes are persisted; a rejected upload returns `400 ValidationError` and writes nothing. **Orphan cleanup**: deleting a record removes the stored blob — storage cleanup is wired through an internal `onAfterDelete` hook (composed with yours), so `DELETE /:id` (and `DELETE /batch`) never leave orphaned objects.

## Endpoints

A file resource exposes the **full resource API** — `GET /` (cursor pagination, `?select`, `?include`, `?filter`), `GET /:id`, `PATCH`/`PUT /:id`, `DELETE /:id`, `GET /count`, `GET /aggregate`, `GET /subscribe`, `POST /rpc/:name` — plus the file-specific routes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Upload (multipart/form-data) → the created file record (fires create hooks + pushes an `added` subscription event) |
| `GET` | `/upload-url` | Presigned upload URL (S3/R2) → `{ fileId, uploadUrl, expiresAt }` |
| `POST` | `/:id/confirm` | Confirm a presigned upload completed → the file record |
| `GET` | `/:id/download` | Stream the file or redirect to a presigned URL |
| `DELETE` | `/batch` | Delete many (`{ ids: [...] }`) → `{ deleted }` |

> **Response shapes match regular resources** (no `{ data }` envelope): `GET /` returns `{ items, nextCursor }`, `GET /:id` and the upload/confirm endpoints return the raw record. The bundled `useFile`/`useFiles`/`useFileUpload` client hooks already speak this shape.

### Admin download

In the [admin data explorer](../tooling/admin-ui.md), rows of a file resource show a **Download** action that streams the stored object (admin-gated), so you can fetch any file regardless of the resource's per-user scopes.

### Direct upload

```bash
curl -X POST http://localhost:3000/api/files -F "file=@photo.jpg"
```

### Presigned upload (S3/R2)

```bash
curl "http://localhost:3000/api/files/upload-url?filename=photo.jpg&contentType=image/jpeg"
curl -X PUT "$UPLOAD_URL" -H "Content-Type: image/jpeg" --data-binary @photo.jpg
curl -X POST "http://localhost:3000/api/files/abc123/confirm"
```

## Relating files to resources

```typescript
export const todosTable = sqliteTable("todos", {
  id: text("id").primaryKey(),
  imageId: text("imageId").references(() => filesTable.id, { onDelete: "set null" }),
});

useResource(todosTable, {
  relations: { image: { resource: "files", schema: filesTable, type: "belongsTo", foreignKey: todosTable.imageId, references: filesTable.id } },
});
// GET /api/todos?include=image
```

## Client

```tsx
import { createFileClient } from "covara/client";
import { useFileUpload, useFiles } from "covara/client/react";

const files = createFileClient({ transport: client.transport, resourcePath: "/api/files" });
await files.upload(file, { onProgress: ({ percent }) => console.log(percent) });
await files.uploadWithPresignedUrl(file);

function UploadButton() {
  const { upload, isUploading, progress } = useFileUpload({ resourcePath: "/api/files" });
  return <input type="file" disabled={isUploading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />;
}
```

See [Client file uploads](../client/files.md).

## Adapter interface

```typescript
interface StorageAdapter {
  upload(key, data, options?): Promise<UploadResult>;
  download(key): Promise<Buffer>;
  downloadStream(key): Promise<Readable>;
  delete(key): Promise<void>;
  deleteMany(keys): Promise<void>;
  exists(key): Promise<boolean>;
  getMetadata(key): Promise<FileMetadata | null>;
  getUrl(key): string | null;
  getDownloadUrl(key, options?): Promise<string | null>;
  getUploadUrl(key, options?): Promise<PresignedUploadResult | null>;
  supportsPresignedUrls(): boolean;
}
```

Globals: `initializeStorage`, `setGlobalStorage`, `getGlobalStorage`, `hasGlobalStorage`.

## Related

- [Client file uploads](../client/files.md) · [Relations](../core/relations.md) · [Workers deployment](../deployment/workers.md)
- [Storage contract](../contracts/storage.md)
