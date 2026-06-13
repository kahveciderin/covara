---
id: files
title: File uploads (client)
sidebar_label: File uploads
description: Upload files from the client with progress, presigned direct-to-bucket uploads, and the useFileUpload / useFile / useFiles React hooks.
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

`uploadWithPresignedUrl` requests a presigned URL, uploads the bytes directly to the bucket, then confirms — offloading the transfer from your server (S3/R2 only).

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

- `useFileUpload` — `{ upload, isUploading, progress, error }`, with `onSuccess`.
- `useFile` — load a single file's metadata/URL.
- `useFiles` — `{ files, isLoading, deleteFile, getDownloadUrl }`.

`getDownloadUrl(id)` returns a URL suitable for `<img>`/`<a>`; on React Native use it to fetch bytes — see [React Native](./react-native.md).

## Relating files

Upload returns a file record whose `id` you can store on another resource (e.g. `todo.imageId`) and load via [`?include=`](../core/relations.md). See [Storage → relating files](../platform/storage.md#relating-files-to-resources).

## Related

- [Storage](../platform/storage.md) · [Relations](../core/relations.md) · [React Native](./react-native.md)
