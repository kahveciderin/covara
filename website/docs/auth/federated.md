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
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
      oidcProviders.microsoft({
        clientId: process.env.MS_CLIENT_ID!,
        clientSecret: process.env.MS_CLIENT_SECRET!,
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

## Related

- [OIDC provider](./oidc-provider.md) · [Client auth](../client/auth.md) · [Auth contract](../contracts/auth.md)
