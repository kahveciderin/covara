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

The Covara client handles this for you. The client transport (`client.session.*` and every other unsafe request) and the React `useAuth()` hook (`login`/`signup`/`logout`/verification) read the `csrf_token` cookie and echo it in `X-CSRF-Token`. If no token cookie has been issued yet, they first make a `GET /me` to get one. The CSRF check covers `/login` itself, so this priming step is what lets a first login succeed. If you renamed the cookie or header on the server, pass the same names to the client:

```typescript
getOrCreateClient({ baseUrl: location.origin, csrf: { cookieName: "xsrf", headerName: "X-XSRF" } });
useAuth({ csrf: { cookieName: "xsrf", headerName: "X-XSRF" } }); // React hook
// csrf: false disables sending the header
```

The token is read from `document.cookie`, so it is only sent from a browser on the same site as the API. A cross-site client should authenticate with a bearer token, which is exempt.

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

- `POST /password/forgot` — `{ email }` → issues a token via `sendToken` (or `composeEmail`); **always** returns `{ success: true }` (no email enumeration). A delivery failure is reported to `email.onDeliveryError` (default: a `console.error` without the address or token) and never changes the response, so a provider outage can't reveal which addresses have accounts.
- `POST /password/reset` — `{ email, token, password }` → hashes the new password with the built-in [scrypt hasher](./passwords.md) and calls `resetPassword`. When `logoutEverywhere` is set and the adapter implements `invalidateUserSessions`, all of the user's sessions are revoked.

## Sending the emails

Each flow takes either a callback (`sendToken` / `sendLink`) that sends the email yourself, or `composeEmail`, which returns an `EmailMessage` that Covara sends through `email.adapter` (default: the [global email adapter](../platform/email.md)). The composed path passes an idempotency key derived from the token's SHA-256 (`auth:<flow>:<hex>`), so a retried send never delivers the same token twice.

```typescript
import { createEmail, durableEmail, createResendAdapter } from "covara/email";

useAuth({
  adapter,
  email: {
    adapter: durableEmail(createResendAdapter({ apiKey: env.RESEND_API_KEY }), { queue: scheduler }),
    onDeliveryError: (error, { flow }) => metrics.increment(`auth.email.${flow}.failed`),
  },
  passwordReset: {
    store,
    resetPassword,
    findUserByEmail,
    composeEmail: ({ identifier, token }) => {
      const { html, text } = createEmail()
        .heading("Reset your password")
        .button("Reset password", `https://app.com/reset?token=${token}`)
        .build();
      return { from: "noreply@app.com", to: identifier, subject: "Reset your password", html, text };
    },
  },
});
```

`/password/forgot` and `/magic-link/request` swallow delivery errors (they must answer identically for known and unknown addresses); `/verify/request` still surfaces them as a `500`. With a [durable email adapter](../platform/email.md#durable-delivery) the request only enqueues the message, so a slow or failing provider affects neither the response nor its latency. `useAuth` throws at setup if a flow has neither a callback nor `composeEmail`.

## Token stores

`verification`, `passwordReset`, and [`magicLink`](./magic-links.md) all use the `VerificationTokenStore` interface (`create`/`consume`/`deleteByIdentifier`). `InMemoryVerificationTokenStore` ships for development; back it with your own table for production. Set `hashTokens: true` to store only the SHA-256 of each token.

## Related

- [Sessions](./sessions.md) · [Passwords](./passwords.md) · [Magic links](./magic-links.md) · [Email](../platform/email.md)
- [Security headers](./security-headers.md) · [Rate limiting](../tooling/middleware.md#rate-limiting)
