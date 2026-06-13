---
id: api-keys
title: API keys
sidebar_label: API keys
description: Standalone helpers to create, verify, list, rotate, and revoke hashed API keys, with a pluggable store.
---

# API keys

Covara provides standalone helpers for issuing and verifying API keys. They are **not** wired into [`useAuth`](./sessions.md) routes — use them in your own endpoints (e.g. a settings page that creates keys, and an adapter's `validateApiKey` that verifies them).

A key is formatted `[prefix_]<id>.<secret>`. Only its **hash** is stored; the raw key is returned once at creation and never again.

```typescript
import {
  createApiKey, verifyApiKey, listApiKeys, revokeApiKey, rotateApiKey, InMemoryApiKeyStore,
} from "covara";

const store = new InMemoryApiKeyStore(); // or your own ApiKeyStore backed by a table

// Create — raw key shown once
const { key, metadata } = await createApiKey({
  store,
  userId: "user_123",
  label: "CI token",
  scopes: ["read"],
  prefix: "myapp",  // optional; prefixes the raw key
  expiresAt: null,  // or a Date / ttlMs
});

// Verify — touches lastUsedAt by default
const result = await verifyApiKey(key, { store });
if (result.valid) {
  // result.metadata: { id, userId, scopes, expiresAt, lastUsedAt, ... }
} else {
  // result.reason: "not_found" | "expired" | "mismatch"
}

await listApiKeys({ store, userId: "user_123" });
await rotateApiKey({ store, id: metadata.id }); // revoke + reissue, inheriting label/scopes/expiry
await revokeApiKey(metadata.id, { store });
```

## The store interface

```typescript
interface ApiKeyStore {
  create(...): Promise<...>;
  list(...): Promise<...>;
  findById(id: string): Promise<...>;
  delete(id: string): Promise<void>;
  touch(id: string): Promise<void>;
}
```

`InMemoryApiKeyStore` is a reference implementation for development; back it with your own table for production.

## Wiring into auth

To authenticate requests carrying a key, validate it in your adapter and return the user/scopes:

```typescript
const adapter = createPassportAdapter({
  getUserById: async (id) => { /* ... */ },
  validateApiKey: async (rawKey) => {
    const result = await verifyApiKey(rawKey, { store });
    return result.valid ? { userId: result.metadata.userId, scopes: result.metadata.scopes } : null;
  },
});
```

The client can send keys via the `X-API-Key` header (`useAuth({ strategy: "apiKey", apiKey })`). See [Client auth](../client/auth.md).

## Related

- [Sessions](./sessions.md) · [JWT](./jwt.md) · [Client auth](../client/auth.md)
