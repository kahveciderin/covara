# Storage (File Upload) Contracts

## Guarantees

### Storage Adapters
- **Adapter interface consistency**: All adapters implement the same `StorageAdapter` interface
- **Global singleton**: Only one storage adapter can be active at a time via `setGlobalStorage()`
- **Upload atomicity**: Uploads either fully succeed or fail; no partial files left behind
- **Stream support**: All adapters support both `Buffer` and `Readable` stream inputs
- **Ranged reads**: Every built-in adapter implements `readRange(key, offset, length)`; a read past the end returns the available bytes (possibly none). Custom adapters without it fall back to `download()` + slice
- **Listing**: Every built-in adapter implements `list({ prefix, cursor, limit })` with lexicographic key order and an opaque continuation cursor; the local adapter never lists `.meta.json` sidecars
- **Optional capabilities are additive**: `readRange`, `list`, and the multipart methods are optional on the interface, so existing custom adapters keep compiling and working

### Local Storage Adapter
- **Directory creation**: Nested directories are created automatically when `createDirectories: true`
- **Metadata persistence**: File metadata stored in sidecar `.meta.json` files
- **URL generation**: Returns URLs when `baseUrl` is configured; null otherwise
- **CreatedAt preservation**: Updating a file preserves its original `createdAt` timestamp
- **Safe static serving**: The auto-mounted `baseUrl` route sends `X-Content-Type-Options: nosniff`, serves active extensions/types (html, svg, xml, js, …) as `application/octet-stream` attachments, and returns 404 for `.meta.json` sidecars and anything under `.covara-uploads/`

### S3 Storage Adapter
- **Presigned URL support**: Always returns presigned URLs for upload/download operations
- **AWS SDK compatibility**: Works with any S3-compatible service (MinIO, DigitalOcean Spaces, etc.)
- **Lazy initialization**: AWS SDK is loaded only when first operation is performed
- **Configurable expiry**: Presigned URL expiration is configurable via `presignedUrlExpiry`
- **Native multipart**: `createMultipartUpload`/`uploadPart`/`completeMultipartUpload` (parts sorted by number)/`abortMultipartUpload` (idempotent: `NoSuchUpload` is ignored)/`listMultipartParts` (paginated)/`getUploadPartUrl`; `multipartLimits` = 5 MiB min part, 5 GiB max part, 10 000 parts
- **Download overrides**: `getDownloadUrl` forwards `responseContentType`/`responseContentDisposition`

### R2 Storage Adapter
- **Two modes**: Bindings mode (Workers R2 binding) or S3 mode (account credentials); `binding` presence selects the mode
- **S3-mode presigned URLs**: S3 mode supports presigned upload/download; bindings mode streams through the Worker
- **Workers-friendly**: The recommended object store on Cloudflare Workers, where local filesystem storage is unavailable
- **Binding multipart**: Bindings mode uses `createMultipartUpload`/`resumeMultipartUpload` when the binding provides them (`supportsMultipartUpload()`), otherwise resumable uploads use the generic fallback

### Memory Storage Adapter
- **In-memory only**: Data is not persisted between restarts
- **No presigned URLs**: Returns null for presigned URL methods
- **Complete isolation**: Each instance has its own isolated storage

### File Resource
- **Superset of a regular resource**: A file resource is a `useResource` resource (full CRUD, list pagination, subscriptions, procedures, relations, field policies, full auth scopes) plus the upload/`upload-url`/`confirm`/`download`/`uploads` routes; responses use the standard resource shapes (no `{ data }` envelope)
- **Multipart parsing**: Accepts multipart/form-data uploads with a single `file` field
- **Content sniffing**: With `contentSniffing: "enforce"` (default) the stored `mimeType` is derived from the first 4 KiB of the content, not from `File.type`/`?contentType=`. An upload is rejected (400) when the content is active (HTML/SVG/XML/script) but declared as anything else, when a declared signature type (image/pdf/zip/audio/video) does not match the bytes (different signature, no signature, truncated, or zero bytes), or when an image/PDF carries `<script>`/`<html>`/`<svg>` markup (polyglot). `"lenient"` stores the sniffed type without rejecting; `"trust-declared"` keeps the legacy declared-type behaviour
- **MIME type validation**: `allowedMimeTypes` and `validation.allowedTypes`/`blockedTypes` are evaluated against the effective (sniffed) type and reject with 400
- **Size validation**: Rejects files exceeding `maxFileSize` / `validation.maxSize` (400 error)
- **Validation before persistence**: Multipart uploads are sized, sniffed and validated before any bytes are written
- **Upload is a tracked create**: A successful upload runs `onBeforeCreate`/`onAfterCreate` hooks and pushes an `added` subscription event, like any resource create. If the row insert fails, the just-written blob is deleted
- **Safe downloads**: `GET /:id/download` always sends `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and an `attachment` disposition with an ASCII-safe `filename` plus RFC 5987 `filename*` (no CR/LF or quote injection). Active types are served as `application/octet-stream`; presigned download redirects carry the same type/disposition overrides. Active-type objects are written to storage as `application/octet-stream` with an attachment disposition
- **Auth scope enforcement**: All operations respect configured auth scopes
- **Database + storage consistency**: Files are only created in database after successful storage upload
- **Key prefix**: `keyPrefix` is prepended to every generated key (multipart, presigned and resumable)

### Durable Deletion
- **Tombstone before row delete**: `DELETE /:id` (via `onBeforeDelete`) and `DELETE /batch` persist a *prepared* tombstone for each storage key before deleting rows. If the tombstone cannot be written, the delete fails and the row is kept
- **Settle after row delete**: After the row delete, the blob is deleted and the tombstone cleared. A storage failure does not fail the request; the tombstone is kept with exponential backoff (`min(base·2^attempts, 5 min)`)
- **Reference check**: A blob is only deleted (by settle, drainer or sweeper) when no row of the resource references its key with a status other than `rejected`. A tombstone whose key is still referenced is dropped, never executed
- **Prepared grace**: Prepared tombstones are not acted on for 5 minutes, so an in-flight delete is never raced
- **Dead set**: After `maxAttempts` (default 10) a tombstone moves to the dead set (`getBlobDeletionStats().dead`) and is logged
- **Crash safety**: A crash at any point leaves either a retryable tombstone (resolved by `drainBlobDeletions`) or an unreferenced blob that `sweepOrphanedBlobs` removes after its grace period. No ordering deletes a still-referenced blob
- **Storage**: Tombstones live in the global KV when configured (`covara:storage:blobdel*`), otherwise in a process-local memory store

### Orphan Sweeper
- **Scope**: Lists keys under each registered file resource's `keyPrefix`. A key is an orphan only if it is older than `graceMs` (default 24 h) and no file resource sharing the same adapter references it
- **Upload parts**: Keys under `<keyPrefix>.covara-uploads/<uploadId>/` are kept while their session is live, and deleted once it is gone, expired or terminal
- **Stale presigned uploads**: `pending`/`rejected` rows older than `pendingUploadTtlMs` (default 24 h) are deleted along with their objects
- **Expired sessions**: Expired resumable sessions are aborted (native multipart abort or part deletion) and removed
- **Dry run**: `dryRun: true` reports without deleting
- **Unlistable adapters**: Adapters without `list` are skipped and counted in `unlistable`

### Presigned Upload Flow (S3)
- **Pending status**: Files created with `status: "pending"` until confirmed
- **Confirmation required**: `/confirm` endpoint must be called after direct S3 upload
- **Verified on confirm**: Confirm reads the object's size and first bytes back from storage, applies size limits, content sniffing and type validation, and stores the sniffed type. On failure the row becomes `status: "rejected"`, the object is deleted, confirm keeps returning 400, and downloads are refused

### Resumable Uploads
- **Session ownership**: A session belongs to its creating user. Anonymous sessions are bound to a random `uploadToken` (only its SHA-256 is stored, compared in constant time). Any other caller gets 404 on every session route, and sessions are scoped to the file resource that created them
- **Create permission**: Creating and completing require the resource's `create` scope
- **Part sizing**: `partSize` is clamped to `[minPartSize, maxPartSize]` (raised to the adapter's `multipartLimits`) and increased so `partCount ≤ maxParts`; impossible plans are refused (400)
- **Exact part sizes**: Every part except the last is exactly `partSize` bytes, the last exactly the remainder. Larger bodies get 413 (bounded read, never buffered beyond the expected size), smaller ones 400, so the assembled size always equals the declared size
- **Idempotent parts**: Re-uploading a part number replaces it. Parts may arrive in any order and in parallel
- **Integrity**: An optional `Covara-Part-Sha256` header is verified per part, and an optional whole-file `checksum` is verified on complete (mismatch → object deleted, session `failed`)
- **Sniffing**: Part 1 is sniffed with the resource's policy; a rejection aborts the whole session. Direct-mode (presigned part) uploads are sniffed and size-checked from storage on complete, and the object is deleted on failure
- **Completion**: Missing parts → 409 with `missingParts` (vanished fallback part objects are reported as missing). Concurrent completes are serialised by a lock (409 while held). Complete is idempotent: once completed it returns the same file record (200). The file id is fixed at session creation, so a retry after a failed insert reuses the assembled object and cannot create duplicates
- **Expiry**: Past `sessionTtlSeconds` the status, part, part-URL and complete routes return 410 (a completed session can still be read); abort still works
- **Abort**: `DELETE /uploads/:id` discards parts / aborts the native upload and deletes the session; later calls get 404
- **Native first**: Adapters implementing the multipart methods are used directly; others use the generic fallback (parts stored as objects and stream-concatenated on complete, then deleted)

## Non-Guarantees

### Storage Behavior (What We Don't Promise)
- ❌ **Cross-adapter compatibility**: Files stored with one adapter cannot be accessed by another
- ❌ **Virus scanning**: No automatic malware detection on uploaded files
- ❌ **Full format validation**: Sniffing checks signatures and markup heuristics on the first 4 KiB; it does not parse or validate whole files
- ❌ **Image processing**: No automatic thumbnail generation or image optimization
- ❌ **Deduplication**: Same file uploaded twice creates two storage entries
- ❌ **Encryption at rest**: Depends on underlying storage configuration

### Data Consistency (What We Don't Promise)
- ❌ **Atomic delete**: Row and blob deletion are not atomic; the tombstone + sweeper make the blob deletion eventual, not immediate, after a storage failure
- ❌ **Transaction support**: Storage operations are not part of database transactions. A delete inside a transaction that later rolls back may have its blob deleted if the deleting connection already saw the row as gone (the sweeper does not resurrect blobs)
- ❌ **Durability without KV**: Without a global KV, tombstones and resumable sessions are process-local and are lost on restart (the sweeper still removes the orphans)
- ❌ **Reference counting**: Deleting a file does not check for references from other resources
- ❌ **Soft-delete blob removal**: With soft delete, the row still references the blob, so the blob is kept

### Performance (What We Don't Promise)
- ❌ **Streaming downloads**: Download endpoint loads entire file into memory for local/memory adapters
- ❌ **Concurrent upload limits**: No built-in rate limiting for uploads
- ❌ **Byte-level resume**: Resumable uploads resume at part granularity; a partially sent part is re-sent
- ❌ **Cheap whole-file checksums on native multipart**: Verifying a whole-file `checksum` on a natively assembled object streams the object back once

## Failure Modes

### No Storage Configured
- `useFileResource()` throws during initialization: "Storage not configured"
- Must call `initializeStorage()` or `setGlobalStorage()` before creating file resource

### Upload Failures
- Network error during S3 upload returns 500 with original error
- Disk full on local storage returns 500 with filesystem error
- Invalid multipart request returns 400 with validation error
- Content that contradicts its declared type returns 400 (`reason`: `active_content_mismatch`, `signature_mismatch` or `polyglot`)

### Download Failures
- File not found in storage returns 404
- File exists in database but missing from storage returns 500
- S3 access denied returns 500 with permission error
- A `pending` or `rejected` file returns 400

### Delete Failures
- Tombstone cannot be written: the delete fails (500) and the row and blob are kept
- Delete from storage fails: the row is deleted, the request succeeds, and the tombstone is retried by `drainBlobDeletions`
- Retries exhausted: tombstone parked in the dead set; the blob remains until an operator acts or the sweeper finds it unreferenced

### Presigned URL Failures
- Adapter doesn't support presigned URLs: returns 400 (validation error)
- S3 credential error: returns 500 when generating presigned URL
- Expired presigned URL: S3 returns 403 directly to client

### Resumable Upload Failures
- Unknown session, wrong owner, or aborted session: 404
- Expired session: 410
- Part too large: 413; part too small / bad part number / part checksum mismatch: 400
- Completed, completing or failed session receiving parts: 409
- Missing parts or completion already in progress: 409

### MIME Type Validation
- Disallowed MIME type returns 400 with list of allowed types
- The checked type is the sniffed type (unless `contentSniffing: "trust-declared"`)

### Size Validation
- File too large returns 400 with configured max size in error message
- Multipart uploads are size-checked after the body is received; resumable parts are bounded per part while streaming

## Test Coverage

- `tests/storage/memory.test.ts` - Memory adapter operations
- `tests/storage/local.test.ts` - Local filesystem adapter operations
- `tests/storage/s3.test.ts` - S3 adapter operations (mocked)
- `tests/storage/r2.test.ts` - R2 adapter (S3 mode mocked, binding mode faked)
- `tests/storage/adapter-extensions.test.ts` - `readRange`, `list`, native multipart (S3 mocked, R2 binding faked)
- `tests/storage/sniff.test.ts` - Signature detection and the enforce/lenient/trust-declared policies
- `tests/storage/file-content-sniffing.test.ts` - Upload/confirm rejection, sniffed-type validation, safe download headers
- `tests/storage/file-deletion-durability.test.ts` - Tombstones, crash points, drainer backoff/dead set, sweeper
- `tests/storage/resumable-upload.test.ts` - Resumable protocol (fallback + native + direct), ownership, expiry, limits
- `tests/storage/local-serving.test.ts` - Hardened local static serving
- `tests/client/file-resumable.test.ts` - Client chunking, retry, resume, pause/abort against a live server
- `tests/client/react-files-resumable.test.ts` - `useFileUpload` resumable wiring
