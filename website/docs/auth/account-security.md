---
id: account-security
title: Account security flows
sidebar_label: Account security
description: Opt-in CSRF protection, login throttling, email verification, and password reset — all layered onto useAuth.
---

# Account security flows

These flows are opt-in via [`useAuth`](./sessions.md) options. They build on the same `adapter` and add routes under the auth router's mount path (e.g. `/api/auth`).

## CSRF protection

```typescript
useAuth({ adapter, login, csrf: true });
// or: csrf: { headerName: "X-CSRF-Token", cookieName: "csrf_token", skip: (c) => false }
```

Uses the **double-submit-cookie** pattern: a non-`httpOnly` `csrf_token` cookie is issued on safe requests and refreshed on login, and unsafe methods (`POST`/`PUT`/`PATCH`/`DELETE`) must echo it back in the `X-CSRF-Token` header. Requests carrying an `Authorization` header (bearer/API-key clients) are exempt. A mismatch returns `403`. Also available standalone as `createCsrfMiddleware`.

## Login throttling

```typescript
useAuth({ adapter, login, throttle: true });
// or: throttle: { maxAttempts: 5, windowMs: 15 * 60 * 1000, store: myRateLimitStore }
```

Failed logins are counted **per email and per IP**; once `maxAttempts` (default 5) is exceeded within the window (default 15 min), `/login` returns `429` with `Retry-After`. A successful login resets the counters. Provide a distributed `RateLimitStore` (e.g. Redis-backed) for multi-instance deployments; the default is in-memory.

## Email verification

```typescript
import { InMemoryVerificationTokenStore } from "covara";

useAuth({
  adapter,
  login,
  verification: {
    store: new InMemoryVerificationTokenStore(),
    sendToken: async ({ identifier, token, expiresAt }) => sendEmail(identifier, token),
    markVerified: async (email) => db.update(users).set({ emailVerified: true }).where(eq(users.email, email)),
    ttlMs: 24 * 60 * 60 * 1000, // default 24h
    hashTokens: true,            // store SHA-256 of the token
  },
});
```

Adds `POST /verify/request` (issues a one-time token and calls `sendToken`) and `POST /verify/confirm` (`{ email, token }` → calls `markVerified`).

## Password reset

```typescript
useAuth({
  adapter,
  login,
  passwordReset: {
    store: new InMemoryVerificationTokenStore(),
    sendToken: async ({ identifier, token }) => sendEmail(identifier, token),
    resetPassword: async (email, passwordHash) =>
      db.update(users).set({ passwordHash }).where(eq(users.email, email)),
    findUserByEmail: async (email) => db.query.users.findFirst({ where: eq(users.email, email) }),
    ttlMs: 60 * 60 * 1000, // default 1h
    logoutEverywhere: true, // revoke all sessions after reset
  },
});
```

Adds:

- `POST /password/forgot` — `{ email }` → issues a token via `sendToken`; **always** returns `{ success: true }` (no email enumeration).
- `POST /password/reset` — `{ email, token, password }` → hashes the new password with the built-in [scrypt hasher](./passwords.md) and calls `resetPassword`. When `logoutEverywhere` is set and the adapter implements `invalidateUserSessions`, all of the user's sessions are revoked.

## Token stores

`verification`, `passwordReset`, and [`magicLink`](./magic-links.md) all use the `VerificationTokenStore` interface (`create`/`consume`/`deleteByIdentifier`). `InMemoryVerificationTokenStore` ships for development; back it with your own table for production. Set `hashTokens: true` to store only the SHA-256 of each token.

## Related

- [Sessions](./sessions.md) · [Passwords](./passwords.md) · [Magic links](./magic-links.md) · [Email](../platform/email.md)
- [Security headers](./security-headers.md) · [Rate limiting](../tooling/middleware.md#rate-limiting)
