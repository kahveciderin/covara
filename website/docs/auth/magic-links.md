---
id: magic-links
title: Magic links
sidebar_label: Magic links
description: Opt-in passwordless email login — request a single-use token and verify it to create a session, without leaking which emails exist.
---

# Magic links

Passwordless login via emailed single-use tokens. Enable it by passing a `magicLink` config to [`useAuth`](./sessions.md).

```typescript
import { InMemoryVerificationTokenStore } from "covara";

useAuth({
  adapter,
  magicLink: {
    store: new InMemoryVerificationTokenStore(),
    sendLink: async ({ identifier, token }) =>
      sendEmail(identifier, `https://app.com/magic?token=${token}`),
    findUserByEmail: async (email) => db.query.users.findFirst({ where: eq(users.email, email) }),
    ttlMs: 15 * 60 * 1000, // default 15m
    hashTokens: true,      // store SHA-256 instead of the raw token
  },
});
```

## Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/magic-link/request` | POST | `{ email }` — issues a single-use token and calls `sendLink` **only if the user exists**, but always returns `{ success: true }` (no email enumeration). |
| `/magic-link/verify` | POST | `{ email, token }` — consumes the token and creates the session, returning `{ user, sessionId }`; invalid/expired returns `401`. |

## Low-level helpers

```typescript
import { issueMagicLinkToken, consumeMagicLinkToken } from "covara";
```

Use these for custom flows (e.g. issuing a link from a different channel).

## Token store

`magicLink.store` implements the `VerificationTokenStore` interface (`create`/`consume`/`deleteByIdentifier`), shared with [email verification and password reset](./account-security.md). `InMemoryVerificationTokenStore` ships for development; back it with your own table for production.

## Related

- [Account security](./account-security.md) · [Sessions](./sessions.md) · [Email](../platform/email.md)
