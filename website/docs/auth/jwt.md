---
id: jwt
title: JWT authentication
sidebar_label: JWT
description: Server-side JWT bearer adapter plus the client JWTClient and useJWTAuth hook with pluggable token storage for web and React Native.
---

# JWT authentication

JWT auth uses signed bearer tokens instead of cookie sessions — a good fit for mobile apps, third-party API clients, and stateless services. Covara provides a server-side JWT adapter and a client `JWTClient` + `useJWTAuth` hook with pluggable token storage.

## Server

Use the JWT adapter so the auth middleware validates `Authorization: Bearer <token>` and populates the [request user](./overview.md#the-request-user).

```typescript
import { createJWTAdapter, useAuth } from "covara";

const adapter = createJWTAdapter({
  secret: process.env.JWT_SECRET!,         // HMAC, or use a key pair for RS256/ES256
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
});

const { router, middleware } = useAuth({
  adapter,
  login: { validateCredentials: async (email, password) => { /* ... */ } },
  signup: { createUser: async (data) => { /* ... */ } },
});
```

`/login` and `/signup` return an access token (and a refresh token when configured) instead of setting a session cookie. Protected routes read the bearer token.

## Client — `useJWTAuth`

```tsx
import { initJWTClient, useJWTAuth } from "covara/client/react";

initJWTClient({ baseUrl: location.origin, authPath: "/api/auth" });

function App() {
  const { user, accessToken, isAuthenticated, login, signup, logout, refresh } = useJWTAuth<User>();

  const onLogin = () => login("user@example.com", "password");
  const onSignup = () => signup("user@example.com", "password", "Jane Doe");

  if (!isAuthenticated) return <button onClick={onLogin}>Sign in</button>;
  return <button onClick={logout}>Sign out {user?.name}</button>;
}
```

Alternatively configure JWT on the main client and let the generic [`useAuth`](../client/auth.md) hook auto-detect the strategy:

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({ baseUrl: location.origin, jwt: { authPath: "/api/auth" } });
```

```tsx
const { user, isAuthenticated, accessToken } = useAuth<User>(); // auto-detects JWT
```

The client refreshes the access token automatically before expiry and retries a request once after a `401` by refreshing. See [Client auth](../client/auth.md).

## Token storage

The client stores tokens through a pluggable `TokenStorage`, so the same code runs in the browser and React Native:

| Storage | Behavior |
|---------|----------|
| `MemoryStorage` | Most secure; tokens lost on refresh. |
| `LocalStorageAdapter("prefix_")` | Persists across tabs/sessions. |
| `SessionStorageAdapter("prefix_")` | Persists until the tab closes. |
| AsyncStorage-compatible | Provide your own for React Native. |

See [React Native](../client/react-native.md) for native token storage.

## Setting a token manually

```typescript
client.setAuthToken("your-jwt-token");
client.clearAuthToken();
```

## Related

- [Sessions](./sessions.md) · [OIDC provider](./oidc-provider.md) · [API keys](./api-keys.md)
- [Client auth](../client/auth.md) · [React Native](../client/react-native.md)
