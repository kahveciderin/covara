---
id: oidc-provider
title: OIDC provider
sidebar_label: OIDC provider
description: A complete OpenID Connect server — authorization code flow with PKCE, token revocation and introspection, dynamic client registration, consent revocation, KV-backed stores, and built-in hardening.
---

# OIDC provider

`createOIDCProvider` turns Covara into a standards-based **OpenID Connect identity server**: authorization-code flow with PKCE, JWT access/ID tokens, refresh-token rotation, federated login, token revocation (RFC 7009) and introspection (RFC 7662), and a login/consent UI — with hardening on by default.

```typescript
import { Hono } from "hono";
import { createOIDCProvider } from "covara";
import { eq } from "drizzle-orm";

const app = new Hono();

const { router, middleware, stores, tokenService } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  tokens: {
    accessToken: { ttlSeconds: 3600 },
    refreshToken: { ttlSeconds: 30 * 24 * 3600, rotateOnUse: true },
  },
  clients: [
    {
      id: "web-app",
      name: "My Web App",
      redirectUris: ["https://myapp.com/callback"],
      postLogoutRedirectUris: ["https://myapp.com"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none", // public client — PKCE required
      scopes: ["openid", "profile", "email", "offline_access"],
    },
  ],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => {
        const u = await db.query.users.findFirst({ where: eq(users.email, email) });
        return u && (await verifyPassword(password, u.passwordHash))
          ? { id: u.id, email: u.email, name: u.name } : null;
      },
      findUserById: async (id) => {
        const u = await db.query.users.findFirst({ where: eq(users.id, id) });
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
    },
  },
});

app.route("/oidc", router);   // OIDC endpoints
app.use("/api/*", middleware); // validates bearer tokens → c.get("user")
```

The return value: `router` (a `Hono` instance), `middleware` (validates bearer tokens and populates the [request user](./overview.md#the-request-user)), `stores`, and `tokenService`.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/openid-configuration` | GET | Discovery document |
| `/authorize` | GET | Authorization code flow with PKCE |
| `/token` | POST | Token exchange & refresh |
| `/userinfo` | GET/POST | User claims |
| `/jwks` | GET | Public keys for verification |
| `/logout` | GET | End session with redirect |
| `/revoke` | POST | Token revocation (RFC 7009) |
| `/introspect` | POST | Token introspection (RFC 7662) |
| `/login` | GET/POST | Login UI (customizable) |
| `/consent` | GET/POST | Consent UI |
| `/consent/revoke` | POST/DELETE | Revoke a user's consent (one client or all) |
| `/register` | POST | Dynamic client registration (opt-in) |

`/revoke` and `/introspect` require client authentication and are advertised in discovery as `revocation_endpoint`/`introspection_endpoint`. Revoking a refresh token invalidates it; introspection returns `{ active, scope, sub, client_id, exp, ... }` for access and refresh tokens.

**Confidential client secrets** may be stored hashed: a secret beginning with `scrypt$` is verified with [`verifyPassword`](./passwords.md); a plaintext secret is compared in constant time. Generate one with `await hashPassword(secret)`.

## Configuration

```typescript
interface OIDCProviderConfig {
  issuer: string;                       // HTTPS in production
  keys: { algorithm?: "RS256" | "ES256"; privateKey?: string | Buffer; rotationIntervalMs?: number };
  tokens?: {
    accessToken?: { ttlSeconds?: number };  // default 3600
    idToken?: { ttlSeconds?: number };      // default 3600
    refreshToken?: { enabled?: boolean; ttlSeconds?: number; rotateOnUse?: boolean }; // 30d, rotate
  };
  clients: OIDCClient[];
  backends: { emailPassword?: EmailPasswordBackendConfig; federated?: FederatedProvider[] };
  stores?: {
    type?: "memory" | "redis" | "drizzle"; // KV-backed by default when a global KV exists
    kv?: KVAdapter; sessionStore?: SessionStore; prefix?: string; db?: unknown;
  };
  ui?: { loginPath?: string; consentPath?: string; templates?: { login?; consent?; error? } };
  security?: {
    pkce?: { required?: boolean; methods?: ("S256")[] };
    consent?: { ttlSeconds?: number };     // default 1 year
    rateLimiting?: { token?; jwks?; introspect? }; // { windowMs, max }
  };
  registration?: { enabled?: boolean; defaultScopes?: string[]; initialAccessToken?: string };
  hooks?: {
    onUserAuthenticated?(user, method): Promise<void>;
    onTokenIssued?(userId, clientId, scopes): Promise<void>;
    onConsentGranted?(userId, clientId, scopes): Promise<void>;
    getAccessTokenClaims?(user, client, scopes): Promise<Record<string, unknown>>;
  };
}
```

## Hardening (on by default)

- **Redirect URI validation** — matched component-by-component (protocol, host, port, normalized path, registered query/fragment), not by prefix. An unregistered URI is rejected with `400` **before** any redirect, so an attacker never receives a redirect.
- **PKCE** — `code_challenge_method=plain` is always rejected (only `S256` is supported/advertised). PKCE is **required for public clients** (`tokenEndpointAuthMethod: "none"`). Set `security.pkce.required: true` to require it for all clients.
- **`at_hash`** — computed correctly (left-half of the hash matching the signing algorithm) whenever an access token is issued.
- **Nonce** — `validateIdTokenNonce(idToken, expectedNonce)` is exported for relying parties.
- **Rate limiting** — `/token`, `/jwks`, `/introspect` can be limited per client or IP via `security.rateLimiting` (uses the global [KV](../platform/kv.md) when present, else an in-memory bucket; emits `X-RateLimit-*` and `429` + `Retry-After`). No limit unless configured.
- **Persistent stores by default** — with a global KV registered, clients, codes, refresh tokens, consents, interactions, and state are KV-backed with expiry-derived TTLs. Pass `stores.type: "memory"` to force in-memory.
- **`login_hint` escaping** — all dynamic values are HTML-escaped in the default login template.

## Dynamic client registration

Enable RFC 7591-style registration:

```typescript
registration: {
  enabled: true,
  defaultScopes: ["openid", "profile", "email"],
  initialAccessToken: env.OIDC_REGISTRATION_TOKEN, // optional gate
}
```

`POST /register` accepts a JSON/form body with at least `redirect_uris` (each validated as a URL), defaults `token_endpoint_auth_method` to `client_secret_basic` (use `none` for public clients), `grant_types` to `["authorization_code"]`, `response_types` to `["code"]`, and returns `201` with a generated `client_id` (+ `client_secret` for confidential clients). Returns `404` when disabled; requires `Authorization: Bearer <initialAccessToken>` when configured. The `registration_endpoint` is added to discovery only when enabled.

## Consent revocation

`POST /consent/revoke` (or `DELETE`) revokes a logged-in user's consent — with `client_id` in the body for one client, without it for all. Requires a valid `oidc_session` cookie (else `401`). Stored consents also expire after `security.consent.ttlSeconds` (default 1 year), after which the user re-consents.

## Federated login

Add Google, Microsoft, Okta, Auth0, Keycloak, or a generic OIDC provider via `backends.federated`. See [Federated login](./federated.md).

## Client side

The Covara client handles the OIDC PKCE flow, token refresh, and 401 retry. See [Client auth](../client/auth.md).

## Related

- [Federated login](./federated.md) · [JWT](./jwt.md) · [Client auth](../client/auth.md)
- [KV store](../platform/kv.md) · [Auth contract](../contracts/auth.md)
