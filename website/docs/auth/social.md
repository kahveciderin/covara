---
id: social
title: Social login (Passport.js)
sidebar_label: Social login
description: Plug any Passport.js OAuth2 strategy (GitHub, Discord, Google, Facebook, Spotify, …) into useAuth as a social login — on Node and Cloudflare Workers — with a one-call client and React hook.
---

# Social login (Passport.js)

Covara can drive **any [Passport.js](https://www.passportjs.org/) OAuth2 strategy** as a social login — GitHub, Discord, Google, Facebook, Spotify, Twitch, GitLab, Slack, and the hundreds of others in the Passport catalog. You construct the strategy exactly as its docs show, wrap it with `fromPassport`, and hand it to [`useAuth`](./sessions.md). A successful login mints the **same session cookie** as a password login, so the rest of your app — `getUser(c)`, scopes, the client — works unchanged.

It runs on **Node and Cloudflare Workers**. See [How it works on Workers](#how-it-works-on-workers).

## Quick start

```bash
npm install passport-github2   # or any passport-* OAuth2 strategy
```

```typescript
import { Strategy as GitHubStrategy } from "passport-github2";
import { useAuth, fromPassport, cookieSession } from "covara";

const { router, middleware } = useAuth({
  // Social login works with ANY session strategy — swap for
  // jwtSession({ secret, getUserById }) to have GitHub login issue JWTs.
  session: cookieSession({
    getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  }),
  social: {
    providers: [
      fromPassport(
        new GitHubStrategy(
          {
            clientID: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            // Point this at the mounted callback route (see below).
            callbackURL: "https://myapp.com/api/auth/social/github/callback",
          },
          // The value you pass to done() becomes the SocialAccount; the bridge
          // normalizes it. Pass the profile straight through.
          (_accessToken, _refreshToken, profile, done) => done(null, profile)
        )
      ),
    ],
    findOrCreateUser: async ({ provider, providerAccountId, profile }) => {
      // Look up or create your app user from the provider account.
      const existing = await db.query.accounts.findFirst({
        where: and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)),
      });
      if (existing) return db.query.users.findFirst({ where: eq(users.id, existing.userId) });

      const user = await createUser({ email: profile.email, name: profile.name, image: profile.image });
      await linkAccount(user.id, provider, providerAccountId);
      return user;
    },
    successRedirect: "/",
  },
});

app.route("/api/auth", router);
app.use("*", middleware);
```

That mounts two routes under the auth router:

| Route | Purpose |
|-------|---------|
| `GET /api/auth/social/:provider` | Start login — redirects the browser to the provider |
| `GET /api/auth/social/:provider/callback` | Provider callback — exchanges the code, resolves the user, sets the session cookie |

`:provider` is the strategy's name (`github`, `discord`, …). Point each strategy's `callbackURL` at its `/callback` route.

## From the client

Both client libraries start a login with a single call. After the server completes the OAuth flow it sets the session cookie and redirects back to `successRedirect`.

**TypeScript:**

```typescript
import { createClient } from "covara/client";

const client = createClient({ baseUrl: location.origin, credentials: "include" });

client.loginWithSocial("github");        // navigates the browser to the provider
// or build the URL yourself (e.g. for an <a href> or React Native):
const url = client.socialLoginUrl("github");
```

**React:**

```tsx
import { useAuth } from "covara/client/react";

function SignIn() {
  const { signInWith, user, isAuthenticated } = useAuth();
  if (isAuthenticated) return <p>Hi {user?.name}</p>;
  return (
    <>
      <button onClick={() => signInWith("github")}>Continue with GitHub</button>
      <button onClick={() => signInWith("discord")}>Continue with Discord</button>
    </>
  );
}
```

If the client is configured with a custom social mount, set it once:

```typescript
createClient({ baseUrl, social: { basePath: "/auth/social" } });
// React, without a client: useAuth({ socialBasePath: "/auth/social" })
```

## `findOrCreateUser`

Called after the provider verifies the user. It receives a `SocialAccount` and must return your app user (`{ id, email?, name?, image? }`):

```typescript
interface SocialAccount {
  provider: string;            // "github"
  providerAccountId: string;   // normalized profile.id — the account link key
  profile: NormalizedProfile;  // { id, email, name, image, username, raw }
  raw: unknown;                // exactly what your strategy's done() returned
}
```

`profile` is normalized from the standard Passport `Profile` shape (`displayName`, `emails`, `photos`, …). For non-standard providers, pass `mapProfile` to `fromPassport` or read `account.raw` directly. If you need the OAuth `accessToken`/`refreshToken`, have your strategy's verify return them (e.g. `done(null, { profile, accessToken })`) with a matching `mapProfile`, then read them off `account.raw`.

## CSRF & state

The bridge persists the strategy's OAuth `state`/PKCE handle between the redirect and the callback using a short-lived, `httpOnly` cookie (`covara_oauth_state`, default 10 min) plus a state store. A callback with a missing, expired, or mismatched state is rejected **before** any code exchange — this is the standard OAuth CSRF protection, enforced by the strategy itself.

- **Single Node process:** the default in-memory state store is fine.
- **Multiple instances / Cloudflare Workers:** the authorize and callback requests can hit different isolates, so use a shared store. If a [global KV](../platform/kv.md) is configured (`setGlobalKV`), the KV-backed store is selected **automatically**. To set it explicitly:

```typescript
import { createKvSocialStateStore } from "covara";

social: {
  providers: [/* ... */],
  findOrCreateUser: async () => { /* ... */ },
  stateStore: createKvSocialStateStore(),   // uses the global KV
}
```

## Configuration

```typescript
social: {
  providers: SocialProvider[];   // from fromPassport(...)
  findOrCreateUser: (account, c) => Promise<AuthUser>;
  basePath?: string;             // default "/social" (under the auth router)
  successRedirect?: string;      // default "/"
  failureRedirect?: string;      // default: 401 JSON problem
  stateStore?: SocialStateStore; // default: KV if configured, else in-memory
  stateCookieName?: string;      // default "covara_oauth_state"
  stateTtlMs?: number;           // default 600000
}
```

`fromPassport(strategy, options?)`:

```typescript
fromPassport(strategy, {
  name?: string;                 // defaults to strategy.name; required if it's the generic "oauth2"
  scope?: string | string[];     // override the requested scopes
  mapProfile?: (raw) => NormalizedProfile,
});
```

## How it works on Workers

Passport strategies don't actually need Express. `Strategy.authenticate(req)` only reads `req.query` / `req.headers` / `req.session` and signals its result through `this.success / fail / redirect / error` — methods Passport core injects, not Express. Covara injects them and synthesizes `req` from the Web request.

The one runtime-specific piece is that OAuth2 strategies do their HTTP through the legacy `node-oauth` package (`node:https`). All of its requests funnel through a single method, which the bridge swaps for `fetch`. After that, token exchange and profile fetch run over `fetch` — so the whole `passport-oauth2` family works on Workers with no `node:http`.

:::note Scope
The bridge covers **OAuth 2.0** strategies (the bulk of the catalog). OAuth 1.0a strategies (e.g. the legacy `passport-twitter`) sign requests with `node-oauth`'s OAuth1 client and are not supported on Workers. Strategies that pull in heavy Node-only crypto (some SAML/enterprise strategies) are Node-only.
:::

## Social login vs the OIDC provider

These solve different problems — see also [Federated login](./federated.md):

| | **Social login (`social` + Passport)** | **[Federated login](./federated.md)** (OIDC provider) |
|---|---|---|
| Use case | *Your* app lets users sign in with GitHub/Discord/Google/… | You run an [OIDC provider](./oidc-provider.md) that delegates to upstream IdPs |
| Provider requirement | Any OAuth 2.0 provider (Passport catalog) | OIDC-compliant IdP (discovery + `id_token`) |
| Covers GitHub/Discord/Spotify/… | ✅ | ❌ (no OIDC discovery document) |
| Result | A Covara **session** for your app | Your provider issues **its own OIDC tokens** |

Reach for **social login** when you just want "sign in with GitHub." Reach for the **OIDC provider** when you're building an identity provider for other apps — and note you can use the *same* Passport strategies there too, via [`backends.passport`](./federated.md#non-oidc-providers-passportjs), which lets your OIDC provider offer GitHub/Discord/… as upstreams and issue its own tokens.
