---
id: sessions
title: Session-based auth
sidebar_label: Sessions
description: The useAuth function — login/signup/logout routes, cookie options, session rotation, lifecycle hooks, auth adapters (Passport, Auth.js), and session stores (in-memory, Redis, Drizzle).
---

# Session-based auth

`useAuth` wires up cookie-session authentication: `/login`, `/signup`, `/logout`, and `/me` routes plus the middleware that populates the request [user](./overview.md#the-request-user). It builds on an **auth adapter** (which owns user lookup and the session store).

```typescript
import { createPassportAdapter, useAuth, hashPassword, verifyPassword } from "covara";
import { eq } from "drizzle-orm";

const adapter = createPassportAdapter({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
});

const { router, middleware } = useAuth({
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

app.route("/api/auth", router);
app.use("*", middleware);
```

With the factory, pass the result directly: `createCovara({ auth: { router, middleware } })` mounts the router at `<basePath>/auth` and applies the middleware (override with `auth: { router, middleware, path: "/auth" }`).

:::tip Session rotation
On a successful `/login`, the prior session cookie (if any) is invalidated before a new session is created — sessions are rotated on every login, mitigating session fixation.
:::

## `useAuth` options

```typescript
interface UseAuthOptions {
  adapter: AuthAdapter;            // required

  cookieName?: string;             // default "session"
  cookieOptions?: {
    httpOnly?: boolean;            // default true
    secure?: boolean;              // default true in production
    sameSite?: "strict" | "lax" | "none"; // default "lax"
    maxAge?: number;               // default 7 days
  };

  login?: { validateCredentials: (email, password) => Promise<AuthUser | null> };
  signup?: {
    createUser: (data: { email; password; name? }) => Promise<AuthUser>;
    validateEmail?: (email) => boolean | Promise<boolean>;
    validatePassword?: (password) => boolean | Promise<boolean>;
  };

  serializeUser?: (user) => Record<string, unknown>;

  onLogin?: (user, c) => void | Promise<void>;
  onLogout?: (user, c) => void | Promise<void>;
  onSignup?: (user, c) => void | Promise<void>;

  // Opt-in flows — see linked pages
  csrf?: boolean | CsrfOptions;             // → Account security
  throttle?: boolean | LoginThrottleOptions; // → Account security
  verification?: VerificationConfig;         // → Account security
  passwordReset?: PasswordResetConfig;       // → Account security
  passwordPolicy?: PasswordPolicy;           // → Passwords
  mfa?: MfaConfig;                           // → MFA
  magicLink?: MagicLinkConfig;               // → Magic links
}
```

## Routes & shapes

```jsonc
// POST /api/auth/login   { "email": "...", "password": "..." }
// → { "user": { "id", "email", "name" }, "sessionId": "sess_..." }

// POST /api/auth/signup  { "email": "...", "password": "...", "name": "..." }
// → { "user": { "id", "email", "name" } }

// GET  /api/auth/me      → { "user": {...}, "expiresAt": "..." }  or  { "user": null }

// POST /api/auth/logout  → { "success": true }
```

## Auth adapters

### Passport adapter

For custom email/password auth:

```typescript
import { createPassportAdapter } from "covara";

const adapter = createPassportAdapter({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  sessionStore: myStore,                  // default: in-memory
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,  // default: 24h
  validateApiKey: async (apiKey) => {     // optional bearer/API-key path
    const k = await db.query.apiKeys.findFirst({ where: eq(apiKeys.key, apiKey) });
    return k ? { userId: k.userId, scopes: k.scopes } : null;
  },
});
```

### Auth.js adapter

For Auth.js / NextAuth tables:

```typescript
import { createAuthJsAdapter } from "covara";

const adapter = createAuthJsAdapter({
  db,
  tables: { users: authUsersTable, sessions: authSessionsTable, accounts: authAccountsTable },
});
```

## Session stores

The adapter owns the session store. Implement the interface or use a built-in.

```typescript
interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
  getAll?(): Promise<SessionData[]>; // optional, used by the admin UI
}
```

| Store | Import | Use |
|-------|--------|-----|
| In-memory | `InMemorySessionStore` | Development; lost on restart |
| Redis | `createRedisSessionStore` (from `covara/auth` stores) | Production, multi-instance |
| Drizzle | Drizzle session store (`covara/auth` stores) | DB-backed sessions |

```typescript
import { InMemorySessionStore } from "covara";
const adapter = createPassportAdapter({ sessionStore: new InMemorySessionStore() /* ... */ });
```

For Redis and Drizzle stores see [`src/auth/stores`]; provide a distributed store so sessions and [login throttling](./account-security.md) work across instances.

## Custom routes

```typescript
import { setCookie } from "hono/cookie";

app.route("/auth", adapter.getRoutes()); // adapter's built-in routes

app.post("/custom-login", async (c) => {
  const { email, password } = await c.req.json();
  const session = await adapter.createSession(userId);
  setCookie(c, "session", session.id, { httpOnly: true });
  return c.json({ success: true });
});
```

## Related

- [Passwords](./passwords.md) · [Account security](./account-security.md) · [MFA](./mfa.md) · [Magic links](./magic-links.md)
- [JWT](./jwt.md) · [Scopes](./scopes.md) · [Client auth](../client/auth.md)
