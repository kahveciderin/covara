---
id: overview
title: Client library overview
sidebar_label: Overview
description: The type-safe, real-time Covara client — setup, configuration, resilient transport, date handling, and the client methods that power queries, subscriptions, and offline sync.
---

# Client library overview

The Covara client is a type-safe, real-time client for your API: typed CRUD, a fluent query builder, live subscriptions, optimistic updates, an offline queue, and React hooks. It's included with the main package.

```typescript
import { createClient, getOrCreateClient } from "covara/client";
import { useLiveList, useAuth } from "covara/client/react";
```

## Setup

Use `getOrCreateClient` for HMR-safe initialization (returns the existing instance if one exists):

```typescript
import { getOrCreateClient } from "covara/client";

export const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});
```

`createClient` always makes a fresh instance.

### Configuration

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | `string` | API server base URL. |
| `credentials` | `RequestCredentials` | `"include"` / `"same-origin"` / `"omit"`. |
| `headers` | `Record<string,string>` | Default headers. |
| `timeout` | `number` | Default request timeout (ms); aborts when exceeded. |
| `offline` | `boolean \| OfflineConfig` | [Offline support](./offline.md). |
| `auth` | `OIDCClientConfig` | [OIDC](./auth.md) flow. |
| `jwt` | `{ authPath }` | [JWT](./auth.md) auth. |
| `billing` | `{ basePath }` | [Billing](./billing.md) client. |
| `onError` | `(error) => void` | A mutation failed to sync. |
| `onSyncComplete` | `() => void` | Offline sync finished. |
| `authCheckUrl` | `string` | Auth status URL (default `/api/auth/me`). |
| `parseDates` | `boolean \| DateFieldRegistry` | Convert ISO date strings to `Date` ([dates](#working-with-dates)). |

## Resilient transport

Built for unreliable networks:

- **Timeouts & cancellation** — a default `timeout` aborts each request via an internal `AbortController`; the low-level transport also accepts a per-request `signal` and `timeoutMs`, combined so either cancels.
- **Automatic 401 refresh-and-retry** — with [`auth`](./auth.md) (OIDC) or `jwt` configured, a `401` triggers one token refresh and a transparent retry; if refresh fails, the original `401` surfaces.
- **SSE reconnect with jitter** — [subscriptions](../realtime/subscriptions.md) reconnect with exponential backoff + randomized jitter (no stampede on server restart) and resume from the last sequence.

## Client methods

```typescript
const todos = client.resource<Todo>("/api/todos");      // typed resource client

client.setAuthToken("jwt");                              // bearer auth
client.clearAuthToken();
client.setAuthErrorHandler(() => location.assign("/login")); // global 401 handler
await client.getPendingCount();                          // queued offline mutations
const { user } = await client.checkAuth();

await client.session.login(email, password);             // email/password session auth
client.loginWithSocial("github");                        // social (Passport) login
// also: session.signup / logout / requestEmailVerification / confirmEmail / me — see Client auth

client.invalidate("/api/todos");                         // mark cached LiveQueries stale → refetch
client.invalidate((path, opts) => opts.filter === "completed==true");
await client.prefetch("/api/todos", { orderBy: "createdAt:desc", limit: 20 }); // warm the cache
```

`invalidate` accepts a path/prefix or a predicate and returns how many cached queries refreshed (propagates across tabs when [`offline.tabSync`](./offline.md) is on). `prefetch` warms the [LiveQuery](./live-queries.md) cache so a later `useLiveList` reads instantly.

## Working with dates

Responses carry dates as ISO 8601 **strings** by default (JSON-safe). Get `Date` objects two ways:

```typescript
import { toDate, toDateOrNull } from "covara/client";

const created = toDate(todo.createdAt);     // Date
const due = toDateOrNull(todo.dueAt);       // Date | null

// or convert on the transport:
const client = createClient({ baseUrl: "/api", parseDates: true });
// scoped: parseDates: { "/api/todos": ["createdAt", "dueAt"] }
```

[Generated types](./typegen.md) mark date columns as the branded `ISODateString` (a `string` subtype) so the compiler steers you toward `toDate(...)`.

## Error handling

```typescript
import { TransportError } from "covara/client";

try {
  await todos.get("nope");
} catch (error) {
  if (error instanceof TransportError) {
    if (error.isNotFound()) {/* 404 */}
    else if (error.isUnauthorized()) {/* 401 */}
    else if (error.isForbidden()) {/* 403 */}
    else if (error.isRateLimited()) console.log("retry after", error.retryAfter);
    else if (error.isValidationError()) console.log(error.details);
  }
}
```

## Where to go next

- **[Queries & repository](./queries.md)** — CRUD, the fluent query builder, filter helpers.
- **[React hooks](./react-hooks.md)** — `useLiveList`, `useMutation`, `useInfiniteList`, and more.
- **[Live queries](./live-queries.md)** — the reactive store under the hooks.
- **[Offline](./offline.md)** · **[Auth](./auth.md)** · **[File uploads](./files.md)** · **[Type generation](./typegen.md)** · **[React Native](./react-native.md)**
