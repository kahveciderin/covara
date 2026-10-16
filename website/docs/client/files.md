---
id: files
title: File uploads (client)
sidebar_label: File uploads
description: Upload files from the client with progress, presigned direct-to-bucket uploads, resumable chunked uploads, and the useFileUpload / useFile / useFiles React hooks.
---

# File uploads (client)

The client talks to a [file resource](../platform/storage.md) for uploads, downloads, listing, and deletion — with upload progress and optional presigned direct-to-bucket transfers.

## Imperative client

```typescript
import { createFileClient } from "covara/client";

const files = createFileClient({ transport: client.transport, resourcePath: "/api/files" });

const result = await files.upload(file, { onProgress: ({ percent }) => console.log(`${percent}%`) });
const result2 = await files.uploadWithPresignedUrl(file, { onProgress: ({ percent }) => {} }); // S3/R2
const { data } = await files.list({ limit: 20 });
await files.delete(fileId);
```

`uploadWithPresignedUrl` requests a presigned URL, uploads the bytes directly to the bucket, then confirms — offloading the transfer from your server (S3/R2 only). The server sniffs the uploaded bytes on confirm and rejects content that contradicts the declared type (see [content sniffing](../platform/storage.md#content-sniffing)).

## Resumable uploads

For large files or flaky connections, `uploadResumable` splits the file into parts, uploads them in parallel with per-part retries, and can pick up where it left off after a network failure or a page reload. It uses the server's [resumable upload protocol](../platform/storage.md#resumable-uploads).

```typescript
const file = await files.uploadResumable(bigFile, {
  concurrency: 4,          // parallel parts (default 3)
  maxRetries: 5,           // per part; network errors, 408/425/429/5xx (default 5)
  retryDelayMs: 500,       // exponential backoff base
  partSize: 16 * 1024 * 1024, // a hint; the server clamps it
  checksum: true,          // sha256 per part + whole file (WebCrypto)
  direct: true,            // S3/R2: PUT parts straight to the bucket when the server allows it
  onProgress: ({ loaded, total, percent }) => console.log(percent),
});
```

**Resume after reload.** The session id (and, for anonymous sessions, the upload token) is saved under a key derived from the resource path and the file's name, size, `lastModified` and type: in `localStorage` when available, in memory otherwise. Pick the same file again and `uploadResumable` asks the server which parts it already has and uploads only the rest. A saved session that expired or was aborted is discarded and a new one is started. Pass `resumeStore` to use your own storage (it needs `get`/`set`/`remove`, sync or async, which suits AsyncStorage on React Native), `resumeStore: false` to disable resuming, or `resumeKey` to choose the key yourself.

**Pause and abort.** `startResumableUpload` returns a handle:

```typescript
const handle = files.startResumableUpload(bigFile);
handle.pause();          // stop now; the server session is kept for a later resume
await handle.abort();    // stop and delete the server session + saved resume record
const result = await handle.promise; // rejects with AbortError after pause/abort
```

`files.getResumableUploadStatus(uploadId, token?)` and `files.abortResumableUpload(uploadId, token?)` are available for custom flows. Progress is reported per completed part. A content rejection (`400`, e.g. HTML disguised as an image) or another non-retryable error forgets the saved session.

## React hooks

```tsx
import { useFileUpload, useFile, useFiles } from "covara/client/react";

function UploadButton() {
  const { upload, isUploading, progress, error } = useFileUpload({
    resourcePath: "/api/files",
    onSuccess: (file) => console.log("uploaded", file.id),
  });
  return (
    <input type="file" disabled={isUploading}
      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
  );
}

function FileList() {
  const { files, isLoading, deleteFile, getDownloadUrl } = useFiles({ resourcePath: "/api/files" });
  return (
    <ul>
      {files.map((f) => (
        <li key={f.id}>
          <a href={getDownloadUrl(f.id)}>{f.filename}</a>
          <button onClick={() => deleteFile(f.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

- `useFileUpload` — `{ upload, isUploading, progress, error, uploadId, pause, abort }`, with `onSuccess`. Pass `resumable: true` (or resumable options such as `{ concurrency: 4 }`) to upload through the resumable protocol; `pause()` keeps the session for a later resume, `abort()` deletes it.
- `useFile` — load a single file's metadata/URL.
- `useFiles` — `{ files, isLoading, deleteFile, getDownloadUrl }`.

`getDownloadUrl(id)` returns a URL suitable for `<img>`/`<a>`; on React Native use it to fetch bytes — see [React Native](./react-native.md).

## Relating files

Upload returns a file record whose `id` you can store on another resource (e.g. `todo.imageId`) and load via [`?include=`](../core/relations.md). See [Storage → relating files](../platform/storage.md#relating-files-to-resources).

## Related

- [Storage](../platform/storage.md) · [Relations](../core/relations.md) · [React Native](./react-native.md)
