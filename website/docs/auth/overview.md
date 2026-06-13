---
id: overview
title: Authentication overview
sidebar_label: Overview
description: Covara's authentication landscape — choose between the built-in OIDC provider and session-based useAuth, populate the request user, and enforce row-level authorization.
---

# Authentication overview

Covara ships a complete authentication and authorization stack. There are two ways to authenticate users, and one consistent way to authorize them.

## Two authentication approaches

| Approach | Use when | Page |
|----------|----------|------|
| **OIDC provider** | You want a standards-based identity server (OAuth2/OIDC, PKCE, federated login, JWT access tokens) for one or many apps. | [OIDC provider](./oidc-provider.md) |
| **Session-based `useAuth`** | You want classic email/password sessions with cookies, the fastest path to login/signup/logout. | [Sessions](./sessions.md) |

Both populate the same request context, so [authorization scopes](./scopes.md), [subscriptions](../realtime/subscriptions.md), and the [client `useAuth` hook](#client-side-useauth) work identically regardless of which you choose.

On top of either approach you can layer: [JWT tokens](./jwt.md), [federated login](./federated.md), [API keys](./api-keys.md), [MFA/TOTP](./mfa.md), [magic links](./magic-links.md), a [password policy](./passwords.md), and [account-security flows](./account-security.md) (CSRF, login throttling, email verification, password reset).

## The request user

After auth middleware runs, the authenticated user is available in any Hono handler:

```typescript
import { getUser, requireUser, getSession } from "covara";

app.get("/api/profile", (c) => {
  const user = requireUser(c); // throws 401 if absent
  return c.json(user);
});
```

`getUser(c)` returns the user or `null`; `requireUser(c)` throws an [`UnauthorizedError`](../tooling/error-handling.md); `getSession(c)` returns the session. These read from Hono's typed `ContextVariableMap` (`user`, `session`, `requestId`, `apiVersion`).

## Quick session setup

```typescript
import { createCovara, createPassportAdapter, useAuth, hashPassword, verifyPassword } from "covara";
import { eq } from "drizzle-orm";

const adapter = createPassportAdapter({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
});

const auth = useAuth({
  adapter,
  login: {
    validateCredentials: async (email, password) => {
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      return user && (await verifyPassword(password, user.passwordHash))
        ? { id: user.id, email: user.email, name: user.name }
        : null;
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const [u] = await db.insert(users)
        .values({ id: crypto.randomUUID(), email, name, passwordHash: await hashPassword(password) })
        .returning();
      return { id: u.id, email: u.email, name: u.name };
    },
  },
});

const app = createCovara({ auth }); // mounts /api/auth/* and the middleware
```

This creates four routes:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/me` | GET | Current user, or `{ user: null }` |
| `/api/auth/login` | POST | Email/password login |
| `/api/auth/signup` | POST | Create account |
| `/api/auth/logout` | POST | Clear session |

Full options and adapters: **[Sessions](./sessions.md)**.

## Route guards

```typescript
import { requireAuth, requireRole, requirePermission, getUser } from "covara";

app.get("/profile", requireAuth(), (c) => c.json(getUser(c)));
app.get("/admin", requireRole("admin"), (c) => c.json({ ok: true }));
app.post("/posts", requirePermission("posts:create"), async (c) => { /* ... */ });
```

## Authorization

Authentication answers *who is this*; **authorization** answers *what can they touch*. Covara enforces row-level access with [RSQL scopes](./scopes.md) on every read, write, subscription, and search — combined with the request filter and impossible to bypass from the client. See [Authorization scopes](./scopes.md) and [Secure queries](./secure-queries.md).

## Client-side `useAuth`

The React [`useAuth`](../client/auth.md) hook exposes the auth state and supports several strategies — cookie sessions, JWT, bearer token, API key, or auto-detect:

```tsx
import { useAuth } from "covara/client/react";

function App() {
  const { user, isAuthenticated, isLoading, logout } = useAuth<User>();
  if (isLoading) return <div>Loading…</div>;
  if (!isAuthenticated) return <LoginPage />;
  return <button onClick={logout}>Sign out {user?.name}</button>;
}
```

See [Client auth](../client/auth.md) for every strategy and the OIDC PKCE flow.

## Related

- [Sessions](./sessions.md) · [JWT](./jwt.md) · [OIDC provider](./oidc-provider.md) · [Federated login](./federated.md)
- [Scopes](./scopes.md) · [Secure queries](./secure-queries.md) · [Passwords](./passwords.md)
- [Auth contract](../contracts/auth.md) — the threat model and guarantees
