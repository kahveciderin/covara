---
id: react-native
title: React Native
sidebar_label: React Native
description: Run the Covara client in React Native — pluggable AsyncStorage-compatible token storage, environment-aware transport and offline backends, and getDownloadUrl for native file handling.
---

# React Native

The Covara client makes no DOM assumptions, so the same client, [repository](./queries.md), [hooks](./react-hooks.md), and [subscriptions](../realtime/subscriptions.md) run in React Native. A few integration points differ from the browser.

## Token storage

OIDC/JWT tokens are stored through a pluggable `TokenStorage`. In the browser the default is `MemoryStorage` (or `LocalStorageAdapter`); in React Native, provide an [AsyncStorage](https://react-native-async-storage.github.io/async-storage/)-compatible adapter:

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "covara/client";

const asyncStorageAdapter = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "mobile-app",
    redirectUri: "myapp://callback",
    storage: asyncStorageAdapter, // satisfies TokenStorage
  },
});
```

The same applies to [`useJWTAuth`](../auth/jwt.md) — pass an AsyncStorage-compatible storage.

## Transport & offline backends

The [transport](./overview.md#resilient-transport) and [offline](./offline.md) layers are environment-aware:

- `fetch` and SSE work over React Native's networking.
- For the offline queue, use `InMemoryOfflineStorage` or supply an AsyncStorage/SQLite-backed `OfflineStorage` implementation (the browser-only `LocalStorageOfflineStorage`/`IndexedDBOfflineStorage` aren't available natively).
- [`offline.tabSync`](./offline.md) (BroadcastChannel) is a no-op outside the browser — leave it off.

```typescript
import { createClient, InMemoryOfflineStorage } from "covara/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  offline: { enabled: true, storage: new InMemoryOfflineStorage() }, // or your AsyncStorage-backed store
});
```

## Files

There's no `<img>`/`<a>` — use `getDownloadUrl(id)` from [`useFiles`](./files.md) (or the file client) to obtain a URL, then fetch the bytes with React Native's `fetch`/`Image` source:

```tsx
const { getDownloadUrl } = useFiles({ resourcePath: "/api/files" });
<Image source={{ uri: getDownloadUrl(file.id) }} />;
```

## Hooks

[`useLiveList`](./react-hooks.md), `useMutation`, `useAuth`, `useJWTAuth`, `useFileUpload`, and the billing hooks all work unchanged — they depend only on React, not the DOM.

## Related

- [Client overview](./overview.md) · [Auth](./auth.md) · [Offline](./offline.md) · [File uploads](./files.md)
