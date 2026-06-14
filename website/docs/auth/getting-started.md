---
id: getting-started
title: Auth quickstart
sidebar_label: Quickstart
description: The fastest way to get real auth working in Covara — email/password with email confirmation plus GitHub social login, with the one table you actually need to create.
---

# Auth quickstart

This is the shortest path to working authentication: **email/password with email confirmation** and **GitHub social login**, on one session. By the end, users can sign up, confirm their email, log in, or click "Continue with GitHub".

## The one table you must create

Covara never owns your **users** table — you provide it and reach it through callbacks. Everything else auth needs (sessions, verification tokens) can live in the [KV store](../platform/kv.md) or memory, so for the fastest start **`users` is the only database table you create**.

See [Internal & system tables](./internal-tables.md) for the full picture — including the optional framework-owned SQL tables (`auth_sessions`, `auth_verification_tokens`, …) you'd switch to in production and exactly which columns they need.

```typescript
// src/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  // null for social-only users who never set a password
  passwordHash: text("password_hash"),
  name: text("name"),
  image: text("image"),
  // null until the user confirms their email; gates email/password login
  emailVerified: integer("email_verified", { mode: "timestamp" }),
});
```

The shape Covara expects back from your lookups is just `{ id, email?, name?, image?, emailVerified? }` — documented under [App-supplied tables → Users](./internal-tables.md#users).

## Type-safe env

Define your config once with [`createEnv`](../deployment/environment-variables.md) — it's Zod-validated, fails fast on a missing var, and is **Workers-safe** (it reads through the runtime-safe primitive under the hood, never `process.env` directly). Reference `env.X` everywhere instead of reaching for `process.env`.

```typescript
// src/env.ts
import { createEnv } from "covara";
import { z } from "zod";

export const env = createEnv({
  APP_URL: z.string().default("http://localhost:3000"),
  PORT: z.string().default("3000").transform(Number),
  RESEND_API_KEY: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
});
```

## Configure auth

`useAuth` wires the adapter, the login/signup/logout routes, **email confirmation** (`verification`), and **social login** (`social`) in one call. Read config from the typed `env` above and send mail with the [email helpers](../platform/email.md).

```typescript
// src/auth.ts
import {
  useAuth,
  cookieSession,
  hashPassword,
  verifyPassword,
  fromPassport,
  InMemoryVerificationTokenStore,
} from "covara";
import { setGlobalEmail, createResendAdapter, sendEmail } from "covara/email";
import { Strategy as GitHubStrategy } from "passport-github2";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";
import { env } from "./env";

// Configure email once (for local dev you can skip this and console.log the link).
setGlobalEmail(createResendAdapter({ apiKey: env.RESEND_API_KEY }));

export const auth = useAuth({
  // Server-side sessions. Swap for jwtSession({ secret: env.JWT_SECRET }) to issue
  // JWTs instead — every provider below works unchanged. See Sessions › strategies.
  session: cookieSession({
    getUserById: (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  }),

  // --- Email / password ---
  login: {
    validateCredentials: async (email, password) => {
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (!user?.passwordHash) return null;                 // social-only or no such user
      if (!(await verifyPassword(password, user.passwordHash))) return null;
      if (!user.emailVerified) return null;                 // block until confirmed
      return { id: user.id, email: user.email, name: user.name };
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const [u] = await db
        .insert(users)
        .values({ email, name, passwordHash: await hashPassword(password) })
        .returning();
      return { id: u.id, email: u.email, name: u.name };
    },
  },

  // --- Email confirmation ---
  verification: {
    store: new InMemoryVerificationTokenStore(), // prod: createKVVerificationTokenStore(kv)
    sendToken: async ({ identifier, token }) => {
      const link = `${env.APP_URL}/verify?email=${encodeURIComponent(identifier)}&token=${token}`;
      await sendEmail({
        from: "Acme <noreply@acme.com>",
        to: identifier,
        subject: "Confirm your email",
        html: `<p>Confirm your email: <a href="${link}">Verify</a></p>`,
        text: `Confirm your email: ${link}`,
      });
    },
    markVerified: async (email) => {
      await db.update(users).set({ emailVerified: new Date() }).where(eq(users.email, email));
    },
  },

  // --- Social login (any Passport.js OAuth2 strategy) ---
  social: {
    providers: [
      fromPassport(
        new GitHubStrategy(
          {
            clientID: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            callbackURL: `${env.APP_URL}/api/auth/social/github/callback`,
          },
          (_accessToken, _refreshToken, profile, done) => done(null, profile)
        )
      ),
    ],
    findOrCreateUser: async ({ profile }) => {
      if (profile.email) {
        const existing = await db.query.users.findFirst({ where: eq(users.email, profile.email) });
        if (existing) return existing;
      }
      const [u] = await db
        .insert(users)
        .values({
          email: profile.email ?? `${profile.username}@github.local`,
          name: profile.name,
          image: profile.image,
          emailVerified: new Date(), // the provider already verified the address
        })
        .returning();
      return u;
    },
    successRedirect: "/",
  },
});
```

```bash
npm install passport-github2   # whichever Passport strategies you use
```

## Mount it

```typescript
// src/index.ts
import { createCovara } from "covara";
import { startServer } from "covara/node";
import { auth } from "./auth";
import { env } from "./env";

const app = createCovara({ auth }); // mounts the auth routes under /api/auth
await startServer(app, { port: env.PORT });
```

This gives you, under `/api/auth`:

| Route | Purpose |
|-------|---------|
| `POST /signup` · `POST /login` · `POST /logout` | email/password |
| `POST /verify/request` · `POST /verify/confirm` | email confirmation |
| `GET /social/github` · `GET /social/github/callback` | GitHub social login |
| `GET /me` | the current user |

## The email-confirmation flow

1. **Sign up** → creates the user with `emailVerified = null`.
2. **Request a token** → `POST /api/auth/verify/request` issues a token and calls your `sendToken` (the email above).
3. **User clicks the link** → your `/verify` page reads `email` + `token` from the URL and calls `POST /api/auth/verify/confirm`.
4. **`markVerified`** stamps `emailVerified` → the `login` check now passes.

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({ baseUrl: location.origin, credentials: "include" });

// after signup, ask the server to email a confirmation link
await client.session.signup({ email, password, name });
await client.session.requestEmailVerification(email);

// on your /verify page (link target from the email)
const params = new URLSearchParams(location.search);
await client.session.confirmEmail(params.get("email")!, params.get("token")!);
```

## From the client

Every auth flow is a first-class client method — no hand-written `fetch`.

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({ baseUrl: location.origin, credentials: "include" });

await client.session.login(email, password); // email/password
client.loginWithSocial("github");            // redirects to GitHub, returns with a session
const user = await client.session.me();       // current user, or null
await client.session.logout();
```

In React the `useAuth` hook exposes the same flows and tracks `user`/`status` for you:

```tsx
import { useAuth } from "covara/client/react";

function SignIn() {
  const { user, isAuthenticated, login, signup, signInWith } = useAuth();
  if (isAuthenticated) return <p>Hi {user?.name}</p>;
  return (
    <>
      <button onClick={() => login("a@b.com", "secret")}>Log in</button>
      <button onClick={() => signup({ email: "a@b.com", password: "secret" })}>Sign up</button>
      <button onClick={() => signInWith("github")}>Continue with GitHub</button>
    </>
  );
}
```

## Going to production

The dev setup above keeps sessions and verification tokens in memory. For real deployments, swap the in-memory pieces for shared stores — no code change beyond the store you pass:

- **Sessions:** pass a `sessionStore` to `createPassportAdapter` — [`createKVSessionStore({ kv })`](./sessions.md) (Redis / Durable Object, no SQL table) or [`createDrizzleSessionStore({ db, resolver })`](./internal-tables.md) (which needs the `auth_sessions` table).
- **Verification tokens:** `createKVVerificationTokenStore(kv)` instead of `InMemoryVerificationTokenStore`.
- **Harden login:** layer on [account security](./account-security.md) (CSRF, login throttling, password policy) and [authorization scopes](./scopes.md) to lock down your resources.

## Related

- [Internal & system tables](./internal-tables.md) · [Sessions](./sessions.md) · [Social login](./social.md) · [Account security](./account-security.md) · [Email](../platform/email.md)
