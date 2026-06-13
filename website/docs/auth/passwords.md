---
id: passwords
title: Passwords
sidebar_label: Passwords
description: Workers-safe scrypt password hashing (hashPassword/verifyPassword/needsRehash) and an enforceable password policy with a built-in denylist.
---

# Passwords

Covara ships a **Workers-safe scrypt** password hasher, so you don't need `bcrypt` or any native dependency. Hashes are self-describing strings (`scrypt$N=...,r=...,p=...$salt$hash`), so parameters can evolve without a schema change.

## Hashing

```typescript
import { hashPassword, verifyPassword, needsRehash } from "covara";

// On signup
const passwordHash = await hashPassword(plaintext);

// On login
if (!(await verifyPassword(plaintext, user.passwordHash))) {
  throw new Error("Invalid credentials");
}

// Upgrade old hashes to stronger params after a successful login
if (needsRehash(user.passwordHash)) {
  await db.update(users).set({ passwordHash: await hashPassword(plaintext) }).where(eq(users.id, user.id));
}
```

- `hashPassword(password, options?)` accepts scrypt cost parameters (`N`, `r`, `p`, `keylen`, `saltlen`).
- `needsRehash(stored, options?)` returns `true` when the stored hash is weaker than the target parameters (or unparseable).
- `verifyPassword` is constant-time.

These power the [session](./sessions.md), [OIDC](./oidc-provider.md) (confidential client secrets), and [password reset](./account-security.md) paths.

## Password policy

Enforce strength rules on signup and password reset by passing `passwordPolicy` to [`useAuth`](./sessions.md):

```typescript
useAuth({
  adapter,
  login,
  signup,
  passwordPolicy: {
    minLength: 12,
    maxLength: undefined,
    requireUppercase: true,
    requireLowercase: false,
    requireNumber: true,
    requireSymbol: true,
    denylist: ["mycompany"],
    useBuiltInDenylist: true, // default: blocks ~20 common passwords
  },
});
```

When set, the policy is enforced (before your own `signup.validatePassword`) on `POST /signup` and again on `POST /password/reset`. A weak password fails with a `422` listing the violations. The built-in denylist (on by default) blocks ~20 of the most common passwords (`password`, `123456`, `qwerty`, …); disable with `useBuiltInDenylist: false` or extend via `denylist`.

### Standalone helpers

```typescript
import { validatePasswordStrength, enforcePasswordStrength, builtInPasswordDenylist } from "covara";

const { valid, errors } = validatePasswordStrength(password, { minLength: 12 });
enforcePasswordStrength(password, { minLength: 12 }); // throws ValidationError if invalid
```

## Related

- [Sessions](./sessions.md) · [Account security](./account-security.md) · [OIDC provider](./oidc-provider.md)
