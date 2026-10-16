---
id: storage
title: File storage
sidebar_label: Storage
description: File uploads as first-class resources — local/S3/R2/in-memory adapters, useFileResource endpoints, content sniffing, MIME and size validation, presigned URLs, resumable uploads, durable orphan cleanup, and client hooks.
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
  contentSniffing: "enforce",       // "enforce" (default) | "lenient" | "trust-declared"
  keyPrefix: "uploads/",            // prepended to every generated key; scopes the orphan sweeper
  resumable: { partSize: 8 * 1024 * 1024, sessionTtlSeconds: 86400 }, // or false to disable
  generateKey: (filename, userId) => `${userId}/${Date.now()}-${filename}`,
  auth: { /* full scope config: read/create/update/delete/subscribe/public */ },
  hooks: { onAfterCreate: async (ctx, file) => { /* runs after upload */ } },
  relations: { owner: { resource: "users", schema: usersTable, type: "belongsTo", foreignKey: filesTable.userId, references: usersTable.id } },
});
```

**Validation** runs before any bytes are persisted; a rejected upload returns `400 ValidationError` and writes nothing. `allowedMimeTypes` and `validation.allowedTypes`/`blockedTypes` are checked against the **sniffed** content type, not the type the client claims (see below).

## Content sniffing

The browser-supplied `File.type` and the `?contentType=` of a presigned request are only *claims*. A file resource inspects the first 4 KiB of every upload (magic bytes for PNG, JPEG, GIF, WebP, BMP, ICO, TIFF, AVIF/HEIC, PDF, ZIP/DOCX/XLSX, gzip, MP4/MOV, WebM, MP3, WAV, Ogg; markup heuristics for HTML, SVG and XML; JSON/text otherwise) and decides the stored `mimeType` from what the bytes actually are.

| `contentSniffing` | Stored type | Rejects (400) |
|---|---|---|
| `"enforce"` (default) | sniffed type (a more specific compatible declared type such as DOCX over ZIP is kept) | declared type contradicts the content dangerously: HTML/SVG/XML/script content under any other declared type, a declared signature type (e.g. `image/png`) whose bytes have a different or no signature (spoofed, truncated, or zero-byte), and image/PDF polyglots carrying `<script>`/`<html>`/`<svg>` markup |
| `"lenient"` | sniffed type | never |
| `"trust-declared"` | declared type (legacy behaviour) | never |

A mislabelled-but-harmless file (a real PNG declared `text/plain`, or anything declared `application/octet-stream`) is accepted and stored with its sniffed type. Sniffing is isomorphic (`sniffContentType`, `resolveContentType` are exported) and dependency-free.

- **Multipart uploads** are sniffed before anything is written.
- **Presigned uploads** are sniffed at `POST /:id/confirm` by reading the first bytes back from storage (`readRange`). On a mismatch (or a size/type validation failure) the row is marked `status: "rejected"` and the object is deleted; confirm keeps returning 400 and the file can never be downloaded.
- **Resumable uploads** are sniffed when part 1 arrives (or, for direct-to-bucket parts, on complete).

### Safe downloads

`GET /:id/download` always sends `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and an `attachment` `Content-Disposition` with an RFC 5987-encoded filename (no header injection from hostile filenames). **Active types** (HTML, SVG, XML, XHTML, JavaScript, any `+xml`) are served as `application/octet-stream`, and the same overrides are passed to presigned download URLs (`response-content-type` / `response-content-disposition`). Objects with an active type are also written to the bucket as `application/octet-stream` with an attachment disposition. The auto-mounted local `baseUrl` serving adds `nosniff`, forces active extensions to download, and refuses to serve `.meta.json` sidecars and in-progress upload parts.

## Durable deletion and the orphan sweeper

Deleting a file never leaves a blob without a way to clean it up:

1. **Before** the row is deleted, a *prepared* tombstone for the storage key is persisted (KV when `setGlobalKV` is configured, an in-process store otherwise). If the tombstone cannot be written, the delete fails and nothing changes.
2. The row is deleted.
3. The blob is deleted and the tombstone cleared. If the storage call fails, the request still succeeds and the tombstone is kept with exponential backoff.

`drainBlobDeletions()` retries tombstones. Before deleting it re-checks that **no row still references the key** (a crash before step 2, a rolled-back delete, or the same key re-used by another row just drops the tombstone), and parks a tombstone in a dead set after `maxAttempts` (default 10). `DELETE /batch` uses the same order: tombstones, then one delete for the rows, then the blobs. A failed row insert after a multipart upload deletes the just-written blob the same way.

`sweepOrphanedBlobs()` is the backstop. It lists keys under each file resource's `keyPrefix` (adapters implement `list`), deletes objects older than `graceMs` (default 24 h) that no row of **any** file resource sharing that adapter references, deletes `pending`/`rejected` presigned-upload rows (and their objects) older than `pendingUploadTtlMs` (default 24 h), and aborts expired resumable sessions (native multipart abort, or deletion of the stored parts). Pass `dryRun: true` to see what would go.

```typescript
import {
  drainBlobDeletions,
  sweepOrphanedBlobs,
  runStorageMaintenance,
  startStorageMaintenance,
  defineStorageMaintenanceTask,
  getBlobDeletionStats,
} from "covara";

// Node: background timers (drain every 30s, sweep hourly)
const stop = startStorageMaintenance({ graceMs: 24 * 3600_000 });

// Workers / cron: one pass from a scheduled handler
await runStorageMaintenance();

// Task queue: register a recurring task
const storageMaintenance = defineStorageMaintenanceTask();
```

:::warning Scope the sweeper
The sweeper treats every unreferenced key under the scanned prefix as an orphan. If the bucket also holds data that is not managed by a file resource, set a `keyPrefix` on your file resources so only that prefix is scanned.
:::

Without a configured KV, tombstones and resumable sessions live in process memory: they survive transient storage failures but not a restart. The sweeper still catches the leftovers. Configure KV (Redis or the Durable Object store) for crash-durable tombstones and for sessions that work across processes.

## Resumable uploads

Large files can be uploaded in parts and resumed after a network failure or a page reload. Sessions are stored in KV with a TTL, and only their creator can continue them: the same user, or, for an anonymous session, whoever holds the `uploadToken` returned at creation (sent as the `Covara-Upload-Token` header). Anyone else gets `404`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/uploads` | Create a session: `{ filename, size, contentType?, partSize?, checksum?: { algorithm: "sha256", value }, direct? }` → `201 { uploadId, uploadToken?, partSize, partCount, direct, expiresAt }` |
| `PUT` | `/uploads/:uploadId/parts/:n` | Upload part `n` (raw body). Idempotent: re-uploading a part replaces it. Optional `Covara-Part-Sha256` header is verified |
| `GET` | `/uploads/:uploadId` | Session status: `{ parts, missingParts, receivedBytes, status, expiresAt, fileId }`, used to resume |
| `GET` | `/uploads/:uploadId/parts/:n/url` | Presigned direct-to-bucket part URL (S3/R2-S3, `direct: true` sessions) |
| `POST` | `/uploads/:uploadId/complete` | Assemble and create the file record (`201`; repeating it returns the same record with `200`) |
| `DELETE` | `/uploads/:uploadId` | Abort: discards the stored parts or the native multipart upload |

Rules the server enforces:

- **Sizes**: the declared `size` is capped by `resumable.maxSize`, `maxFileSize` and `validation.maxSize`. Every part except the last must be exactly `partSize` bytes and the last exactly the remainder; a larger body gets `413`, a shorter one `400`. The total therefore can never exceed the declared size.
- **Part bounds**: `partSize` is clamped to `[minPartSize, maxPartSize]` (defaults 5 MiB / 64 MiB, raised to the adapter's own limits, e.g. S3's 5 MiB minimum) and is increased automatically so `partCount ≤ maxParts` (default 10 000). If that is impossible the session is refused.
- **Content**: part 1 is sniffed with the same policy as normal uploads, so a mismatch aborts the whole session. Direct-mode uploads are sniffed and size-checked on complete, and the object is deleted if they fail.
- **Completion**: completing with missing parts returns `409` with `missingParts`. Concurrent completes are serialised (`409` while one is in progress). A whole-file `checksum` mismatch deletes the object and marks the session `failed`. If the row insert fails after assembly, retrying `complete` reuses the assembled object instead of re-assembling it.
- **Expiry**: after `sessionTtlSeconds` (default 24 h) every call returns `410`. The sweeper aborts the upload and removes its parts.
- **Zero-byte files** are allowed (`partCount: 0`; complete writes an empty object).

Adapters with native multipart support (S3 / R2 in S3 mode: `CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`AbortMultipartUpload`; the R2 Workers binding: `createMultipartUpload`/`resumeMultipartUpload`) are used directly. Other adapters (local, memory, custom) use a generic fallback: parts are stored as objects under `<keyPrefix>.covara-uploads/<uploadId>/<n>` and concatenated (streamed) on complete. For S3, also add a bucket lifecycle rule (`AbortIncompleteMultipartUpload`) as a safety net for sessions whose KV record expired before the sweeper ran.

## Endpoints

A file resource exposes the **full resource API** — `GET /` (cursor pagination, `?select`, `?include`, `?filter`), `GET /:id`, `PATCH`/`PUT /:id`, `DELETE /:id`, `GET /count`, `GET /aggregate`, `GET /subscribe`, `POST /rpc/:name` — plus the file-specific routes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Upload (multipart/form-data) → the created file record (fires create hooks + pushes an `added` subscription event) |
| `GET` | `/upload-url` | Presigned upload URL (S3/R2) → `{ fileId, uploadUrl, expiresAt }` |
| `POST` | `/:id/confirm` | Confirm a presigned upload completed (content is sniffed; mismatches are rejected) → the file record |
| `GET` | `/:id/download` | Stream the file (safe headers) or redirect to a presigned URL |
| `DELETE` | `/batch` | Delete many (`{ ids: [...] }`) → `{ deleted }` |
| `POST`/`PUT`/`GET`/`DELETE` | `/uploads…` | [Resumable uploads](#resumable-uploads) |

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
await files.uploadResumable(bigFile, { concurrency: 4, onProgress: ({ percent }) => console.log(percent) });

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

  // Optional capabilities (all built-in adapters implement the first two)
  readRange?(key, offset, length): Promise<Buffer>;           // content sniffing on confirm
  list?({ prefix?, cursor?, limit? }): Promise<{ objects, cursor? }>; // orphan sweeper
  multipartLimits?: { minPartSize; maxPartSize; maxParts };
  createMultipartUpload?(key, options?): Promise<{ uploadId }>;
  uploadPart?(key, uploadId, partNumber, data): Promise<{ etag }>;
  completeMultipartUpload?(key, uploadId, parts): Promise<UploadResult>;
  abortMultipartUpload?(key, uploadId): Promise<void>;
  listMultipartParts?(key, uploadId): Promise<MultipartPart[]>;      // direct mode
  getUploadPartUrl?(key, uploadId, partNumber, options?): Promise<string | null>; // direct mode
}
```

A custom adapter without `readRange` falls back to `download()` for sniffing. Without `list`, the sweeper skips the orphan scan (reported as `unlistable`). Without the multipart methods, resumable uploads use the generic fallback.

Globals: `initializeStorage`, `setGlobalStorage`, `getGlobalStorage`, `hasGlobalStorage`.

## Related

- [Client file uploads](../client/files.md) · [Relations](../core/relations.md) · [Workers deployment](../deployment/workers.md)
- [Storage contract](../contracts/storage.md)
