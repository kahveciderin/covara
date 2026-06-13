# Storage (File Upload) Contracts

## Guarantees

### Storage Adapters
- **Adapter interface consistency**: All adapters implement the same `StorageAdapter` interface
- **Global singleton**: Only one storage adapter can be active at a time via `setGlobalStorage()`
- **Upload atomicity**: Uploads either fully succeed or fail; no partial files left behind
- **Stream support**: All adapters support both `Buffer` and `Readable` stream inputs

### Local Storage Adapter
- **Directory creation**: Nested directories are created automatically when `createDirectories: true`
- **Metadata persistence**: File metadata stored in sidecar `.meta.json` files
- **URL generation**: Returns URLs when `baseUrl` is configured; null otherwise
- **CreatedAt preservation**: Updating a file preserves its original `createdAt` timestamp

### S3 Storage Adapter
- **Presigned URL support**: Always returns presigned URLs for upload/download operations
- **AWS SDK compatibility**: Works with any S3-compatible service (MinIO, DigitalOcean Spaces, etc.)
- **Lazy initialization**: AWS SDK is loaded only when first operation is performed
- **Configurable expiry**: Presigned URL expiration is configurable via `presignedUrlExpiry`

### R2 Storage Adapter
- **Two modes**: Bindings mode (Workers R2 binding) or S3 mode (account credentials); `binding` presence selects the mode
- **S3-mode presigned URLs**: S3 mode supports presigned upload/download; bindings mode streams through the Worker
- **Workers-friendly**: The recommended object store on Cloudflare Workers, where local filesystem storage is unavailable

### Memory Storage Adapter
- **In-memory only**: Data is not persisted between restarts
- **No presigned URLs**: Returns null for presigned URL methods
- **Complete isolation**: Each instance has its own isolated storage

### File Resource
- **Superset of a regular resource**: A file resource is a `useResource` resource (full CRUD, list pagination, subscriptions, procedures, relations, field policies, full auth scopes) plus the upload/`upload-url`/`confirm`/`download` routes; responses use the standard resource shapes (no `{ data }` envelope)
- **Multipart parsing**: Accepts multipart/form-data uploads with a single `file` field
- **MIME type validation**: Rejects files with disallowed MIME types (400 error)
- **Size validation**: Rejects files exceeding `maxFileSize` (400 error)
- **Validation option**: The `validation` option (`maxSize`/`allowedTypes`/`blockedTypes`) is enforced on both direct uploads and presigned-URL requests, before any bytes are persisted
- **Upload is a tracked create**: A successful upload runs `onBeforeCreate`/`onAfterCreate` hooks and pushes an `added` subscription event, like any resource create
- **Orphan cleanup on delete**: deleting a record removes the stored blob via an internal `onAfterDelete` hook (composed with the user's), so no orphaned objects remain; `DELETE /batch` removes blobs then rows
- **Auth scope enforcement**: All operations respect configured auth scopes
- **Database + storage consistency**: Files are only created in database after successful storage upload

### Presigned Upload Flow (S3)
- **Pending status**: Files created with `status: "pending"` until confirmed
- **Confirmation required**: `/confirm` endpoint must be called after direct S3 upload
- **Metadata sync**: Confirmation fetches actual size and MIME type from S3

## Non-Guarantees

### Storage Behavior (What We Don't Promise)
- ❌ **Cross-adapter compatibility**: Files stored with one adapter cannot be accessed by another
- ❌ **Virus scanning**: No automatic malware detection on uploaded files
- ❌ **Image processing**: No automatic thumbnail generation or image optimization
- ❌ **Deduplication**: Same file uploaded twice creates two storage entries
- ❌ **Encryption at rest**: Depends on underlying storage configuration

### Data Consistency (What We Don't Promise)
- ❌ **Atomic delete**: Deleting a record removes the database row, then the stored blob (via `onAfterDelete`); a crash between steps can leave an orphaned blob
- ❌ **Transaction support**: Storage operations are not part of database transactions
- ❌ **Reference counting**: Deleting a file does not check for references from other resources

### Performance (What We Don't Promise)
- ❌ **Streaming downloads**: Download endpoint loads entire file into memory for local/memory adapters
- ❌ **Concurrent upload limits**: No built-in rate limiting for uploads
- ❌ **Resumable uploads**: Interrupted uploads must be restarted from scratch

## Failure Modes

### No Storage Configured
- `useFileResource()` throws during initialization: "Storage not configured"
- Must call `initializeStorage()` or `setGlobalStorage()` before creating file resource

### Upload Failures
- Network error during S3 upload returns 500 with original error
- Disk full on local storage returns 500 with filesystem error
- Invalid multipart request returns 400 with validation error

### Download Failures
- File not found in storage returns 404
- File exists in database but missing from storage returns 500
- S3 access denied returns 500 with permission error

### Delete Failures
- Delete from storage fails: file remains in database (inconsistent state)
- Delete from database fails: file removed from storage but remains in database

### Presigned URL Failures
- Adapter doesn't support presigned URLs: returns 400 (validation error)
- S3 credential error: returns 500 when generating presigned URL
- Expired presigned URL: S3 returns 403 directly to client

### MIME Type Validation
- Disallowed MIME type returns 400 with list of allowed types
- MIME type detection relies on client-provided Content-Type header

### Size Validation
- File too large returns 400 with configured max size in error message
- Size is checked after upload completes (not streaming validation)

## Test Coverage

- `tests/storage/memory.test.ts` - Memory adapter operations
- `tests/storage/local.test.ts` - Local filesystem adapter operations
- `tests/storage/s3.test.ts` - S3 adapter operations (mocked)
