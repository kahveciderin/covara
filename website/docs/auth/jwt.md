---
id: jwt
title: JWT authentication
sidebar_label: JWT
description: Server-side JWT bearer adapter plus the client JWTClient and useJWTAuth hook with pluggable token storage for web and React Native.
---

# JWT authentication

JWT auth uses signed bearer tokens instead of cookie sessions — a good fit for mobile apps, third-party API clients, and stateless services. Covara provides a server-side JWT adapter and a client `JWTClient` + `useJWTAuth` hook with pluggable token storage.

## Server

Use the `jwtSession` [session strategy](./sessions.md#session-strategies) so the middleware validates `Authorization: Bearer <token>` and populates the [request user](./overview.md#the-request-user). It's decoupled from how the user logs in — so the **same credential providers** (`login`, `signup`, [`social`](./social.md), …) issue JWTs instead of cookies just by swapping the strategy.

```typescript
import { jwtSession, useAuth } from "covara";

const { router, middleware } = useAuth({
  session: jwtSession({
    secret: env.JWT_SECRET,         // HMAC, or a key pair for RS256/ES256
    getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
    refreshStore: kvStore,          // optional: revocable refresh tokens
  }),
  login: { validateCredentials: async (email, password) => { /* ... */ } },
  signup: { createUser: async (data) => { /* ... */ } },
});
```

`/login` and `/signup` return `{ accessToken, expiresIn, tokenType: "Bearer" }` and set an `httpOnly` refresh cookie (instead of a session cookie); `POST /api/auth/refresh` mints a fresh access token. Protected routes read the bearer token.

> **Migrating from `createJWTAdapter`:** the standalone `createJWTAdapter` (mounted via its own `getRoutes()` + `middleware`) still works but is deprecated in favor of `jwtSession`, which integrates with `useAuth` (and its social/MFA/magic-link providers). Its options map 1:1.

## Client

With `jwtSession`, the standard [`useAuth()` hook](../client/auth.md) handles JWTs uniformly — `login`/`signup` capture the returned access token and send it as a bearer on subsequent requests (and `client.session.login` does the same outside React):

```tsx
import { useAuth } from "covara/client/react";

function SignIn() {
  const { login, signup, signInWith } = useAuth<User>();
  // login(email, password) -> stores the JWT and authenticates; same code as a cookie session
}
```

For finer control (manual token storage, refresh scheduling, React Native), use the dedicated `useJWTAuth` hook / `JWTClient`:

### `useJWTAuth`

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
