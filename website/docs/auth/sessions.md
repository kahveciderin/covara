---
id: sessions
title: Session-based auth
sidebar_label: Sessions
description: The useAuth function — login/signup/logout routes, cookie options, session rotation, lifecycle hooks, auth adapters (Passport, Auth.js), and session stores (in-memory, Redis, Drizzle).
---

# Session-based auth

`useAuth` wires up authentication: `/login`, `/signup`, `/logout`, and `/me` routes plus the middleware that populates the request [user](./overview.md#the-request-user). Two concerns are **decoupled**:

- **A session strategy** (`session:`) — *how* the authenticated identity is persisted, validated per request, and issued at login. Pick [`cookieSession`](#session-strategies) (server-side sessions) or [`jwtSession`](#session-strategies) (stateless JWTs).
- **Credential providers** — *who* the user is at login: `login`, `signup`, [`social`](./social.md), [`verification`](./account-security.md), [`mfa`](./mfa.md), [`magicLink`](./magic-links.md).

They compose freely: **any provider works with any session strategy** (e.g. [Passport social login that issues JWTs](#session-strategies)).

```typescript
import { cookieSession, useAuth, hashPassword, verifyPassword } from "covara";
import { eq } from "drizzle-orm";

const { router, middleware } = useAuth({
  session: cookieSession({
    getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  }),
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
  session: SessionStrategy;        // cookieSession(...) | jwtSession(...)
  adapter?: AuthAdapter;           // deprecated: legacy adapter (mapped to a session internally)

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

## Session strategies

The `session` strategy decides how the identity is persisted and validated — independent of how the user logged in. Both take `getUserById` (to hydrate the user from a session/token).

### `cookieSession` — server-side sessions

An opaque id in an `httpOnly` cookie, backed by a [session store](#session-stores). Revocable; rotates on login.

```typescript
import { cookieSession } from "covara";

cookieSession({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  store: myStore,                 // default: in-memory; use KV/Drizzle in prod
  cookieName: "session",          // default
  ttlMs: 24 * 60 * 60 * 1000,     // default
});
```

### `jwtSession` — stateless JWTs

Issues a short-lived access token (returned from `/login` as `{ accessToken }`) plus a refresh token (in an `httpOnly` cookie); validates the `Authorization: Bearer` header. Mounts `/refresh`.

```typescript
import { jwtSession } from "covara";

jwtSession({
  getUserById,
  secret: env.JWT_SECRET,
  accessTokenTtl: 15 * 60,            // seconds
  refreshTokenTtl: 7 * 24 * 60 * 60,
  refreshStore: kvStore,             // optional: makes refresh tokens revocable
});
```

### Any provider × any session

Because the strategy is decoupled from the credential providers, you can, for example, log in with **a Passport.js provider and issue JWTs** — previously impossible:

```typescript
import { useAuth, jwtSession, fromPassport } from "covara";
import { Strategy as GitHubStrategy } from "passport-github2";

useAuth({
  session: jwtSession({ getUserById, secret: env.JWT_SECRET, refreshStore }),
  social: {
    providers: [fromPassport(new GitHubStrategy({ /* ... */ }, (_a, _r, p, done) => done(null, p)))],
    findOrCreateUser: async ({ profile }) => upsertUser(profile),
  },
});
// GitHub login → refresh cookie set → POST /api/auth/refresh → bearer access token
```

### Legacy adapters (deprecated)

`createPassportAdapter` / `createAuthJsAdapter` / `createJWTAdapter` still work — pass one as `adapter` and `useAuth` maps it to a session strategy internally. Prefer `session` for new code.

```typescript
import { createPassportAdapter } from "covara";
useAuth({ adapter: createPassportAdapter({ getUserById }), login: { /* ... */ } });
```

## Session stores

`cookieSession` (and the legacy adapters) take a session store. Implement the interface or use a built-in.

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
| KV (Redis / Durable Object / memory) | `createKVSessionStore` (from `covara/auth` stores) | Production, multi-instance |
| Drizzle | Drizzle session store (`covara/auth` stores) | DB-backed sessions |

```typescript
import { cookieSession, InMemorySessionStore } from "covara";
cookieSession({ getUserById, store: new InMemorySessionStore() });
```

`createKVSessionStore({ kv })` is backed by the [KV abstraction](../platform/kv.md), so it works with **any** KV adapter — Redis, the Cloudflare Durable Object store, or the in-memory store for tests — not only Redis:

```typescript
import { cookieSession } from "covara";
import { createKVSessionStore } from "covara/auth";
cookieSession({ getUserById, store: createKVSessionStore({ kv }) });
```

> `createRedisSessionStore` / `RedisSessionStore` remain as deprecated aliases of `createKVSessionStore` / `KVSessionStore`.

For Redis and Drizzle stores see [`src/auth/stores`]; provide a distributed store so sessions and [login throttling](./account-security.md) work across instances.

## Custom routes

A strategy's `issue(c, userId)` mints + transmits a session/token (sets the cookie for `cookieSession`, returns tokens for `jwtSession`) — reuse it in your own routes:

```typescript
import { cookieSession, readJsonBody } from "covara";

const session = cookieSession({ getUserById });

app.post("/custom-login", async (c) => {
  const { email, password } = await readJsonBody(c);
  const user = await validate(email, password);
  if (!user) return c.json({ error: "invalid" }, 401);
  const issued = await session.issue(c, user.id); // sets the session cookie
  return c.json({ user: issued.user });
});
```

## Related

- [Passwords](./passwords.md) · [Account security](./account-security.md) · [MFA](./mfa.md) · [Magic links](./magic-links.md)
- [JWT](./jwt.md) · [Scopes](./scopes.md) · [Client auth](../client/auth.md)
