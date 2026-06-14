---
id: federated
title: Federated login
sidebar_label: Federated login
description: Add Google, Microsoft, Okta, Auth0, Keycloak, or any generic OIDC provider as a login backend, with verified id_token handling.
---

# Federated login

The [OIDC provider](./oidc-provider.md) can delegate authentication to upstream identity providers (social login) via `backends.federated`. Users authenticate with Google/Microsoft/etc. and your provider issues its own tokens.

```typescript
import { createOIDCProvider, oidcProviders } from "covara";

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  clients: [/* ... */],
  backends: {
    emailPassword: { enabled: true, validateUser: async () => { /* ... */ }, findUserById: async () => { /* ... */ } },
    federated: [
      oidcProviders.google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      }),
      oidcProviders.microsoft({
        clientId: env.MS_CLIENT_ID,
        clientSecret: env.MS_CLIENT_SECRET,
        tenantId: "common", // or a specific tenant
      }),
      oidcProviders.generic({
        name: "custom",
        clientId: "...",
        clientSecret: "...",
        issuer: "https://custom-idp.example.com",
        scopes: ["openid", "email", "profile"],
      }),
    ],
  },
});
```

## Provider helpers

| Helper | Provider |
|--------|----------|
| `oidcProviders.google(...)` | Google |
| `oidcProviders.microsoft(...)` | Microsoft / Entra ID (`tenantId`) |
| `oidcProviders.okta(...)` | Okta |
| `oidcProviders.auth0(...)` | Auth0 |
| `oidcProviders.keycloak(...)` | Keycloak |
| `oidcProviders.generic(...)` | Any OIDC provider (`issuer`, `scopes`) |

## How id_token verification works

Federated `id_token`s are **signature-verified** against the provider's JWKS (fetched from its discovery document and cached), with issuer and audience checks. After verification:

1. the `nonce` is compared to the stored interaction nonce, and
2. the `id_token`'s `sub` is cross-checked against the `userinfo` `sub`.

Any mismatch aborts the login. This closes token-substitution and replay vectors.

## Non-OIDC providers (Passport.js)

`backends.federated` only works with **OIDC-compliant** identity providers (they expose a discovery document and an `id_token`). For OAuth-2-only providers — GitHub, Discord, Spotify, Twitch, … — use `backends.passport`, which drives any [Passport.js](https://www.passportjs.org/) OAuth2 strategy and resumes the same authorization interaction. Like everything in Covara, it runs on Node **and** Cloudflare Workers (see [Social login](./social.md#how-it-works-on-workers) for the mechanism).

```bash
npm install passport-github2
```

```typescript
import { Strategy as GitHubStrategy } from "passport-github2";
import { createOIDCProvider, fromPassport } from "covara";

createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  clients: [/* ... */],
  backends: {
    emailPassword: { enabled: true, /* ... */ },
    passport: {
      providers: [
        fromPassport(
          new GitHubStrategy(
            {
              clientID: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              // All passport providers share ONE callback under the provider:
              callbackURL: "https://auth.myapp.com/auth/passport/callback",
            },
            (_a, _r, profile, done) => done(null, profile)
          )
        ),
      ],
      findUserByAccount: async (provider, providerAccountId) => /* existing user or null */,
      findUserById: async (id) => /* user by id — used by consent/token/userinfo */,
      createUser: async (account) => /* create user from account.profile */,
    },
  },
});
```

Each provider appears as a button on the login page, mounted under `/auth/passport/:provider` (start) and `/auth/passport/callback` (shared callback — the provider is recovered from signed state). On success the provider establishes its session and continues to consent / the authorization code exactly like an email/password login, so your relying parties receive normal OIDC tokens. `findUserById` is required here so consent, `/token`, and `/userinfo` can resolve the user when no email/password backend is configured.

The config mirrors [`useAuth({ social })`](./social.md) — same `fromPassport` wrapper and `SocialAccount` — the difference is the result: `backends.passport` issues **your provider's** OIDC tokens, while `useAuth` mints a local session.

:::note Scope
Covers OAuth 2.0 strategies (the bulk of the catalog). OAuth 1.0a strategies are Node-only and not supported on Workers — see [Social login](./social.md#how-it-works-on-workers).
:::

## Related

- [OIDC provider](./oidc-provider.md) · [Social login](./social.md) · [Client auth](../client/auth.md) · [Auth contract](../contracts/auth.md)
