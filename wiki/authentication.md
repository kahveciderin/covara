# Authentication

Concave provides a complete authentication system built on OpenID Connect (OIDC). The framework can act as its own OIDC Provider, giving you standard OAuth2/OIDC flows, JWT tokens, and compatibility with any OIDC client.

## OIDC Provider (Recommended)

The OIDC provider gives you a complete identity server with standard endpoints, PKCE support, and pluggable authentication backends.

### Quick Setup

```typescript
import { Hono } from "hono";
import { createOIDCProvider } from "@kahveciderin/concave";

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
      tokenEndpointAuthMethod: "none", // Public client, PKCE required
      scopes: ["openid", "profile", "email", "offline_access"],
    },
  ],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => {
        const user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (user && await verifyPassword(password, user.passwordHash)) {
          return { id: user.id, email: user.email, name: user.name };
        }
        return null;
      },
      findUserById: async (id) => {
        const user = await db.query.users.findFirst({ where: eq(users.id, id) });
        return user ? { id: user.id, email: user.email, name: user.name } : null;
      },
    },
  },
});

// Mount OIDC routes at /oidc
app.route("/oidc", router);

// Protect API routes with the middleware
app.use("/api/*", middleware);
app.route("/api", apiRoutes);
```

The provider returns `{ router, middleware, stores, tokenService }` — `router` is a `Hono` instance, `middleware` is a Hono `MiddlewareHandler` that validates bearer tokens and populates the request context (`c.get("user")`).

### OIDC Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/openid-configuration` | GET | Discovery document |
| `/authorize` | GET | Authorization code flow with PKCE |
| `/token` | POST | Token exchange, refresh |
| `/userinfo` | GET/POST | User claims |
| `/jwks` | GET | Public keys for verification |
| `/logout` | GET | End session with redirect |
| `/revoke` | POST | Token revocation (RFC 7009) |
| `/introspect` | POST | Token introspection (RFC 7662) |
| `/login` | GET/POST | Login UI (customizable) |
| `/consent` | GET/POST | Consent UI |
| `/consent/revoke` | POST/DELETE | Revoke a user's consent (one client or all) |
| `/register` | POST | Dynamic client registration (opt-in) |

`/revoke` and `/introspect` require client authentication and are advertised in the
discovery document as `revocation_endpoint` and `introspection_endpoint`. Revoking a
refresh token invalidates it; introspection returns the standard `{ active, scope, sub,
client_id, exp, ... }` response for both access and refresh tokens.

Confidential client secrets may be stored hashed. A secret that begins with `scrypt$` is
verified with the built-in scrypt hasher (`hashPassword`/`verifyPassword`); a plaintext
secret is compared in constant time. Generate a hash with `await hashPassword(secret)` and
store the result as the client's `secret`.

### Provider Configuration

```typescript
interface OIDCProviderConfig {
  // Required: Your issuer URL (must be HTTPS in production)
  issuer: string;

  // Key configuration
  keys: {
    algorithm?: "RS256" | "ES256";  // default: RS256
    privateKey?: string | Buffer;    // Or auto-generate
    rotationIntervalMs?: number;
  };

  // Token lifetimes
  tokens?: {
    accessToken?: { ttlSeconds?: number };   // default: 3600
    idToken?: { ttlSeconds?: number };       // default: 3600
    refreshToken?: {
      enabled?: boolean;
      ttlSeconds?: number;    // default: 30 days
      rotateOnUse?: boolean;  // default: true
    };
  };

  // Registered clients
  clients: OIDCClient[];

  // Authentication backends
  backends: {
    emailPassword?: EmailPasswordBackendConfig;
    federated?: FederatedProvider[];
  };

  // Store configuration
  // KV-backed stores are used by default whenever a global KV is registered (setGlobalKV);
  // set type: "memory" to force in-memory even with a global KV present.
  stores?: {
    type?: "memory" | "redis" | "drizzle";
    kv?: KVAdapter;       // explicit KV for the OIDC stores
    sessionStore?: ...;   // session store for the login/consent UI
    prefix?: string;      // KV key prefix (default: "oidc")
    db?: unknown;         // for the drizzle store
    tables?: ...;
  };

  // UI customization
  ui?: {
    loginPath?: string;     // default: /login
    consentPath?: string;   // default: /consent
    templates?: {
      login?: string;       // Custom HTML template
      consent?: string;
      error?: string;
    };
  };

  // Hardening (see "Security & Hardening" below)
  security?: {
    pkce?: { required?: boolean; methods?: ("S256")[] };
    consent?: { ttlSeconds?: number };  // default: 1 year
    rateLimiting?: {
      token?: { windowMs: number; max: number };
      jwks?: { windowMs: number; max: number };
      introspect?: { windowMs: number; max: number };
    };
  };

  // Dynamic client registration (opt-in)
  registration?: {
    enabled?: boolean;            // default: false (POST /register returns 404 when off)
    defaultScopes?: string[];     // default: ["openid", "profile", "email"]
    initialAccessToken?: string;  // if set, /register requires Bearer <token>
  };

  // Lifecycle hooks
  hooks?: {
    onUserAuthenticated?: (user, method) => Promise<void>;
    onTokenIssued?: (userId, clientId, scopes) => Promise<void>;
    onConsentGranted?: (userId, clientId, scopes) => Promise<void>;
    getAccessTokenClaims?: (user, client, scopes) => Promise<Record<string, unknown>>;
  };
}
```

### Federated Identity (Social Login)

Add Google, Microsoft, or other OIDC providers:

```typescript
import { createOIDCProvider, oidcProviders } from "@kahveciderin/concave";

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  clients: [/* ... */],
  backends: {
    // Email/password for direct login
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => { /* ... */ },
      findUserById: async (id) => { /* ... */ },
    },
    // Federated providers
    federated: [
      oidcProviders.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
      oidcProviders.microsoft({
        clientId: process.env.MS_CLIENT_ID!,
        clientSecret: process.env.MS_CLIENT_SECRET!,
        tenantId: "common", // or specific tenant
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

Available provider helpers: `google`, `microsoft`, `okta`, `auth0`, `keycloak`, `generic`.

Federated `id_token`s are signature-verified against the provider's JWKS (fetched from its discovery
document and cached), with issuer and audience checks. After verification the `nonce` is compared to
the stored interaction nonce, and the `id_token`'s `sub` is cross-checked against the `userinfo`
`sub`; any mismatch aborts the login.

### Security & Hardening

The provider applies a number of OAuth2/OIDC hardening measures by default:

- **Redirect URI validation** — `redirect_uri` is matched component-by-component (protocol, host,
  port, normalized path, and query/fragment when registered), not by prefix. An unregistered URI is
  rejected with a `400` before any redirect happens, so an attacker never receives a redirect.
- **PKCE** — `code_challenge_method=plain` is always rejected (only `S256` is supported and
  advertised). PKCE is **required for public clients** (`tokenEndpointAuthMethod: "none"`). Set
  `security.pkce.required: true` to require it for all clients.
- **at_hash** — the `id_token` `at_hash` claim is computed correctly (left-half of the hash matching
  the signing algorithm) whenever an access token is issued.
- **Nonce** — `validateIdTokenNonce(idToken, expectedNonce)` is exported for clients/relying parties
  that need to validate the `id_token` nonce.
- **Rate limiting** — `/token`, `/jwks`, and `/introspect` can be rate-limited per client (or per IP)
  via `security.rateLimiting`. Limiters use the global KV when registered, else an in-memory bucket,
  and emit `X-RateLimit-*` headers plus `429` + `Retry-After` when exceeded. No limit is applied
  unless the corresponding key is configured.
- **Persistent stores by default** — when a global KV is registered, the provider's clients, codes,
  refresh tokens, consents, interactions, and state are KV-backed with TTLs derived from each record's
  expiry. Pass `stores.type: "memory"` to force in-memory.
- **login_hint escaping** — the `login_hint` (and all dynamic values) are HTML-escaped in the default
  login template.

### Dynamic Client Registration

Enable RFC 7591-style dynamic registration with `registration.enabled: true`:

```typescript
createOIDCProvider({
  // ...
  registration: {
    enabled: true,
    defaultScopes: ["openid", "profile", "email"],
    initialAccessToken: process.env.OIDC_REGISTRATION_TOKEN, // optional gate
  },
});
```

`POST /register` accepts a JSON (or form) body with at least `redirect_uris` (each validated as a
URL). It defaults `token_endpoint_auth_method` to `client_secret_basic` (use `none` for a public
client), `grant_types` to `["authorization_code"]`, and `response_types` to `["code"]`. It returns
`201` with a generated `client_id` (and `client_secret` for confidential clients). When `enabled` is
false the endpoint returns `404`; when `initialAccessToken` is set, a matching `Authorization: Bearer`
header is required. The `registration_endpoint` is added to the discovery document only when enabled.

### Consent Revocation

`POST /consent/revoke` (or `DELETE /consent/revoke`) revokes a logged-in user's consent. With a
`client_id` in the body it revokes consent for that one client; without it, it revokes all of the
user's consents. The request must carry a valid `oidc_session` cookie (else `401`). Stored consents
also expire after `security.consent.ttlSeconds` (default 1 year), after which the user is prompted to
consent again.

## Client-Side OIDC Authentication

The Concave client library handles OIDC flows automatically with PKCE, token refresh, and 401 retry.

### Basic Setup

```typescript
import { createClient } from "@kahveciderin/concave/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

// Login - redirects to OIDC provider
await client.auth.login();

// Handle callback (on /callback page)
await client.auth.handleCallback();

// Token is automatically included in all requests
const todos = client.resource<Todo>("/todos");
const items = await todos.list();

// Check auth state
if (client.auth.isAuthenticated()) {
  const user = client.auth.getUser();
  console.log("Logged in as:", user?.name);
}

// Logout
await client.auth.logout();
```

### Subscribe to Auth State

```typescript
const unsubscribe = client.auth.subscribe((state) => {
  console.log("Auth status:", state.status);
  console.log("User:", state.user);
  console.log("Is authenticated:", state.isAuthenticated);
});

// Cleanup
unsubscribe();
```

### React Integration

```typescript
import { useState, useEffect } from "react";
import { createClient, AuthState } from "@kahveciderin/concave/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

function useAuth() {
  const [state, setState] = useState<AuthState>(client.auth.getState());

  useEffect(() => {
    return client.auth.subscribe(setState);
  }, []);

  return {
    ...state,
    login: () => client.auth.login(),
    logout: () => client.auth.logout(),
  };
}

function App() {
  const { user, isAuthenticated, status, login, logout } = useAuth();

  if (status === "initializing") return <div>Loading...</div>;

  if (!isAuthenticated) {
    return <button onClick={login}>Sign In</button>;
  }

  return (
    <div>
      Welcome, {user?.name}!
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### Callback Page

```typescript
// /callback page
function CallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.auth.handleCallback()
      .then(() => {
        window.location.href = "/";
      })
      .catch((err) => {
        setError(err.message);
      });
  }, []);

  if (error) return <div>Error: {error}</div>;
  return <div>Completing sign in...</div>;
}
```

### Token Storage Options

```typescript
import {
  createClient,
  MemoryStorage,
  LocalStorageAdapter,
  SessionStorageAdapter,
} from "@kahveciderin/concave/client";

// Memory storage (default - most secure, tokens lost on refresh)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new MemoryStorage(),
  },
});

// Local storage (persists across tabs/sessions)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new LocalStorageAdapter("myapp_"),
  },
});

// Session storage (persists until tab close)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new SessionStorageAdapter("myapp_"),
  },
});
```

### Auth Configuration Options

```typescript
interface OIDCClientConfig {
  // Required
  issuer: string;           // OIDC provider URL
  clientId: string;         // Client ID
  redirectUri: string;      // Callback URL

  // Optional
  postLogoutRedirectUri?: string;  // Where to redirect after logout
  scopes?: string[];               // default: ["openid", "profile", "email"]
  autoRefresh?: boolean;           // default: true
  refreshBufferSeconds?: number;   // default: 60 (refresh 60s before expiry)
  storage?: TokenStorage;          // default: MemoryStorage
  flowType?: "redirect" | "popup"; // default: "redirect"
}
```

---

## Session-Based Authentication (Legacy)

For traditional session-based auth without OIDC, use the original `useAuth` function.

## Quick Setup

The `useAuth` function creates auth routes and middleware in one call:

```typescript
import { Hono } from "hono";
import { createPassportAdapter, useAuth, hashPassword, verifyPassword } from "@kahveciderin/concave";

const app = new Hono();

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    return db.query.users.findFirst({ where: eq(users.id, id) });
  },
});

const { router, middleware } = useAuth({
  adapter: authAdapter,
  login: {
    validateCredentials: async (email, password) => {
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (user && await verifyPassword(password, user.passwordHash)) {
        return { id: user.id, email: user.email, name: user.name };
      }
      return null;
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const id = crypto.randomUUID();
      const [user] = await db.insert(users).values({
        id,
        email,
        name,
        passwordHash: await hashPassword(password),
      }).returning();
      return { id: user.id, email: user.email, name: user.name };
    },
  },
});

// Mount auth routes at /api/auth
app.route("/api/auth", router);

// Add auth middleware to populate the user in the request context
app.use("*", middleware);
```

`router` is a `Hono` instance and `middleware` is a Hono `MiddlewareHandler`. After the middleware runs, the user is available in handlers via `c.get("user")` or the `getUser(c)` / `requireUser(c)` helpers.

With `createConcave`, pass the result directly:

```typescript
const app = createConcave({
  auth: { router, middleware },  // mounts router at <basePath>/auth, applies middleware
  // auth: { router, middleware, path: "/auth" },  // custom mount path
});
```

This creates the following routes:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/me` | GET | Returns current user or `{ user: null }` |
| `/api/auth/login` | POST | Login with email/password |
| `/api/auth/signup` | POST | Create new account |
| `/api/auth/logout` | POST | Clear session |

## useAuth Options

```typescript
interface UseAuthOptions {
  // Required: auth adapter for session management
  adapter: AuthAdapter;

  // Optional: cookie configuration
  cookieName?: string;  // default: "session"
  cookieOptions?: {
    httpOnly?: boolean;   // default: true
    secure?: boolean;     // default: true in production
    sameSite?: "strict" | "lax" | "none";  // default: "lax"
    maxAge?: number;      // default: 7 days
  };

  // Optional: enable login route
  login?: {
    validateCredentials: (email: string, password: string) => Promise<AuthUser | null>;
  };

  // Optional: enable signup route
  signup?: {
    createUser: (data: { email: string; password: string; name?: string }) => Promise<AuthUser>;
    validateEmail?: (email: string) => boolean | Promise<boolean>;
    validatePassword?: (password: string) => boolean | Promise<boolean>;
  };

  // Optional: customize user serialization
  serializeUser?: (user: UserContext) => Record<string, unknown>;

  // Optional: lifecycle hooks (c is the Hono Context)
  onLogin?: (user: UserContext, c: Context) => void | Promise<void>;
  onLogout?: (user: UserContext | null, c: Context) => void | Promise<void>;
  onSignup?: (user: AuthUser, c: Context) => void | Promise<void>;

  // Optional: security flows (see "Account Security" below)
  csrf?: boolean | CsrfOptions;
  throttle?: boolean | LoginThrottleOptions;
  verification?: {
    store: VerificationTokenStore;
    sendToken: (params: { identifier: string; token: string; expiresAt: Date; c: Context }) => void | Promise<void>;
    markVerified: (identifier: string) => void | Promise<void>;
    ttlMs?: number;       // default: 24h
    hashTokens?: boolean; // store SHA-256 of the token instead of the raw value
  };
  passwordReset?: {
    store: VerificationTokenStore;
    sendToken: (params: { identifier: string; token: string; expiresAt: Date; c: Context }) => void | Promise<void>;
    resetPassword: (identifier: string, passwordHash: string) => void | Promise<void>;
    findUserByEmail?: (identifier: string) => Promise<{ id: string } | null>;
    ttlMs?: number;       // default: 1h
    hashTokens?: boolean;
    logoutEverywhere?: boolean; // invalidate all of the user's sessions after reset
  };

  // Optional: enforce a password policy on signup and password reset
  passwordPolicy?: {
    minLength?: number;            // default: 8
    maxLength?: number;
    requireUppercase?: boolean;    // default: false
    requireLowercase?: boolean;    // default: false
    requireNumber?: boolean;       // default: false
    requireSymbol?: boolean;       // default: false
    denylist?: string[];
    useBuiltInDenylist?: boolean;  // default: true (blocks ~20 common passwords)
  };

  // Optional: TOTP-based multi-factor authentication (see "Multi-Factor Authentication")
  mfa?: {
    issuer?: string;
    totp?: { step?: number; digits?: number; window?: number };
    backupCodeCount?: number;      // default: 10
    requireOnLogin?: boolean;      // gate /login on a second factor when enrolled
    getUserByEmail: (email: string) => Promise<(AuthUser & { mfa?: MfaEnrollment | null }) | null>;
    getEnrollment: (userId: string) => Promise<MfaEnrollment | null>;
    saveEnrollment: (userId: string, enrollment: MfaEnrollment) => void | Promise<void>;
    saveBackupCodeHashes?: (userId: string, hashes: string[]) => void | Promise<void>;
    consumeBackupCode?: (userId: string, index: number) => void | Promise<void>;
  };

  // Optional: passwordless magic-link login (see "Magic Links")
  magicLink?: {
    store: VerificationTokenStore;
    sendLink: (params: { identifier: string; token: string; expiresAt: Date; c: Context }) => void | Promise<void>;
    findUserByEmail: (identifier: string) => Promise<AuthUser | null>;
    ttlMs?: number;       // default: 15m
    hashTokens?: boolean;
  };
}
```

On a successful `/login`, the prior session cookie (if any) is invalidated before a new
session is created — sessions are rotated on every login.

## Password Hashing

Concave ships a Workers-safe scrypt password hasher, so you don't need `bcrypt` or any
native dependency. Hashes are self-describing strings (`scrypt$N=...,r=...,p=...$salt$hash`),
so parameters can evolve without a separate column.

```typescript
import { hashPassword, verifyPassword, needsRehash } from "@kahveciderin/concave";

// On signup
const passwordHash = await hashPassword(plaintext);

// On login
if (!(await verifyPassword(plaintext, user.passwordHash))) {
  throw new Error("Invalid credentials");
}

// Optionally upgrade old hashes to stronger parameters after a successful login
if (needsRehash(user.passwordHash)) {
  await db.update(users).set({ passwordHash: await hashPassword(plaintext) }).where(eq(users.id, user.id));
}
```

`hashPassword(password, options?)` accepts scrypt cost parameters (`N`, `r`, `p`, `keylen`,
`saltlen`); `needsRehash(stored, options?)` returns `true` when the stored hash is weaker
than the target parameters (or unparseable). All three are constant-time on comparison.

## Account Security

These flows are opt-in via `useAuth` options. They build on the same `adapter` and add
routes under the auth router's mount path (e.g. `/api/auth`).

### CSRF Protection

```typescript
useAuth({ adapter, login, csrf: true });
// or: csrf: { headerName: "X-CSRF-Token", cookieName: "csrf_token", skip: (c) => ... }
```

Uses the double-submit-cookie pattern: a non-`httpOnly` `csrf_token` cookie is issued on
safe requests and refreshed on login, and unsafe methods (`POST`/`PUT`/`PATCH`/`DELETE`)
must echo it back in the `X-CSRF-Token` header. Requests carrying an `Authorization` header
(bearer/API-key clients) are exempt. A mismatch returns `403`. The middleware is also
available standalone as `createSecurityHeaders`'s sibling `createCsrfMiddleware`.

### Login Throttling

```typescript
useAuth({ adapter, login, throttle: true });
// or: throttle: { maxAttempts: 5, windowMs: 15 * 60 * 1000, store: myRateLimitStore }
```

Failed logins are counted per email and per IP; once `maxAttempts` (default 5) is exceeded
within the window (default 15 minutes), `/login` returns `429` with a `Retry-After`. A
successful login resets the counters. Provide a distributed `RateLimitStore` (e.g.
Redis-backed) for multi-instance deployments; the default is in-memory.

### Email Verification

```typescript
import { InMemoryVerificationTokenStore } from "@kahveciderin/concave";

useAuth({
  adapter,
  login,
  verification: {
    store: new InMemoryVerificationTokenStore(),
    sendToken: async ({ identifier, token, expiresAt }) => sendEmail(identifier, token),
    markVerified: async (email) => db.update(users).set({ emailVerified: true }).where(eq(users.email, email)),
  },
});
```

Adds `POST /verify/request` (issues a one-time token and calls `sendToken`) and
`POST /verify/confirm` (`{ email, token }` → calls `markVerified`). Set `hashTokens: true`
to store only the SHA-256 of the token.

### Password Reset

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
    logoutEverywhere: true,
  },
});
```

Adds `POST /password/forgot` (`{ email }` → issues a token via `sendToken`; always returns
`{ success: true }` to avoid leaking which emails exist) and `POST /password/reset`
(`{ email, token, password }` → hashes the new password with the built-in scrypt hasher and
calls `resetPassword`). When `logoutEverywhere` is set and the adapter implements
`invalidateUserSessions`, all of the user's existing sessions are revoked after the reset.

The token stores implement the `VerificationTokenStore` interface
(`create`/`consume`/`deleteByIdentifier`); `InMemoryVerificationTokenStore` is provided for
development, and you can back it with your own database for production.

### Password Policy

```typescript
useAuth({
  adapter,
  login,
  signup,
  passwordPolicy: {
    minLength: 12,
    requireUppercase: true,
    requireNumber: true,
    requireSymbol: true,
  },
});
```

When set, the policy is enforced (before your own `signup.validatePassword`) on `POST /signup` and
again on `POST /password/reset`. A weak password fails with a `422` validation error listing the
violations. The built-in denylist (enabled by default) blocks roughly 20 of the most common
passwords (`password`, `123456`, `qwerty`, …); disable it with `useBuiltInDenylist: false` or extend
it with your own `denylist`. The policy helpers are also available standalone:

```typescript
import { validatePasswordStrength, enforcePasswordStrength, builtInPasswordDenylist } from "@kahveciderin/concave";

const { valid, errors } = validatePasswordStrength(password, { minLength: 12 });
enforcePasswordStrength(password, { minLength: 12 }); // throws ValidationError if invalid
```

### Multi-Factor Authentication (TOTP)

```typescript
useAuth({
  adapter,
  login,
  mfa: {
    issuer: "My App",
    requireOnLogin: true,
    getUserByEmail: async (email) => db.query.users.findFirst({ where: eq(users.email, email) }),
    getEnrollment: async (userId) => db.query.mfa.findFirst({ where: eq(mfa.userId, userId) }),
    saveEnrollment: async (userId, enrollment) =>
      db.insert(mfa).values({ userId, ...enrollment }).onConflictDoUpdate({ target: mfa.userId, set: enrollment }),
    consumeBackupCode: async (userId, index) => { /* mark backup code `index` used */ },
  },
});
```

Required callbacks: `getUserByEmail`, `getEnrollment`, `saveEnrollment`. The `MfaEnrollment` you store
is `{ secret: string; enabled: boolean; backupCodeHashes?: string[] }`. When `mfa` is set, these
routes are added:

| Route | Method | Description |
|-------|--------|-------------|
| `/mfa/enroll` | POST | Generate a new TOTP secret + backup codes for the current user (saved as `enabled: false`). Returns `{ secret, otpauthUri, backupCodes }` (codes shown once). |
| `/mfa/enroll/confirm` | POST | `{ code }` — verify the first TOTP and flip the enrollment to `enabled: true`. |
| `/mfa/verify` | POST | `{ email, code }` — second-factor step of login; on success creates the session. Accepts a TOTP code or a backup code. |

Login flow: when `requireOnLogin` is true and the user has an enabled enrollment, `POST /login` returns
`{ mfaRequired: true }` with `401` if no `mfaCode` is supplied. The client then either resubmits
`/login` with `mfaCode`, or calls `/mfa/verify`. A matched backup code triggers `consumeBackupCode`.

The TOTP primitives are exported for custom flows: `generateTotpSecret`, `generateTotp`, `verifyTotp`,
`getTotpUri`, `generateBackupCodes`, `verifyBackupCode`.

### Magic Links (Passwordless Login)

```typescript
import { InMemoryVerificationTokenStore } from "@kahveciderin/concave";

useAuth({
  adapter,
  magicLink: {
    store: new InMemoryVerificationTokenStore(),
    sendLink: async ({ identifier, token }) => sendEmail(identifier, `https://app.com/magic?token=${token}`),
    findUserByEmail: async (email) => db.query.users.findFirst({ where: eq(users.email, email) }),
    ttlMs: 15 * 60 * 1000,
  },
});
```

Adds `POST /magic-link/request` (`{ email }` → issues a single-use token and calls `sendLink` only if
the user exists; always returns `{ success: true }` to avoid leaking which emails exist) and
`POST /magic-link/verify` (`{ email, token }` → consumes the token and creates the session, returning
`{ user, sessionId }`; an invalid or expired token returns `401`). The low-level helpers
`issueMagicLinkToken` / `consumeMagicLinkToken` are exported for custom flows.

## API Keys

Standalone helpers for issuing and verifying API keys. These are not wired into `useAuth` routes —
use them in your own endpoints (e.g. a settings page that creates keys, and an adapter's
`validateApiKey` that verifies them). A key is formatted `[prefix_]<id>.<secret>`; only its hash is
stored, and the raw key is returned once at creation.

```typescript
import {
  createApiKey,
  verifyApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  InMemoryApiKeyStore,
} from "@kahveciderin/concave";

const store = new InMemoryApiKeyStore(); // or your own ApiKeyStore backed by a table

// Create (raw key shown once)
const { key, metadata } = await createApiKey({
  store,
  userId: "user_123",
  label: "CI token",
  scopes: ["read"],
  prefix: "myapp",          // optional, prefixes the raw key
  expiresAt: null,          // or a Date / ttlMs
});

// Verify (touches lastUsedAt by default)
const result = await verifyApiKey(key, { store });
if (result.valid) {
  // result.metadata: { id, userId, scopes, expiresAt, lastUsedAt, ... }
} else {
  // result.reason: "not_found" | "expired" | "mismatch"
}

await listApiKeys({ store, userId: "user_123" });
await rotateApiKey({ store, id: metadata.id });  // revoke + reissue inheriting label/scopes/expiry
await revokeApiKey(metadata.id, { store });
```

The `ApiKeyStore` interface is `create` / `list` / `findById` / `delete` / `touch`;
`InMemoryApiKeyStore` is a reference implementation for development.

## Auth Adapters

### Passport Adapter

For custom username/password authentication:

```typescript
import { createPassportAdapter } from "@kahveciderin/concave";

const authAdapter = createPassportAdapter({
  // Required: lookup user by ID
  getUserById: async (id) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, id) });
    return user ?? null;
  },

  // Optional: custom session store (default: in-memory)
  sessionStore: myRedisStore,

  // Optional: session TTL (default: 24 hours)
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,

  // Optional: API key validation
  validateApiKey: async (apiKey) => {
    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.key, apiKey) });
    return key ? { userId: key.userId, scopes: key.scopes } : null;
  },
});
```

### Auth.js Adapter

For integration with Auth.js/NextAuth.js:

```typescript
import { createAuthJsAdapter } from "@kahveciderin/concave";

const authAdapter = createAuthJsAdapter({
  db,
  tables: {
    users: authUsersTable,
    sessions: authSessionsTable,
    accounts: authAccountsTable,  // optional
  },
});
```

## Authorization Scopes

Use the `rsql` template helper to define row-level access control:

```typescript
import { useResource, rsql } from "@kahveciderin/concave";

app.route("/api/posts", useResource(postsTable, {
  id: postsTable.id,
  db,
  auth: {
    // Public read access
    public: { read: true },

    // Users can only update their own posts
    update: async (user) => rsql`authorId=="${user.id}"`,

    // Users can delete their own posts or be an admin
    delete: async (user) => {
      if (user.metadata?.role === "admin") {
        return rsql`*`;  // All posts
      }
      return rsql`authorId=="${user.id}"`;
    },

    // Subscription scope
    subscribe: async (user) => rsql`authorId=="${user.id}"`,
  },
}));
```

## Scope Patterns

Common patterns are available as presets:

```typescript
import { scopePatterns } from "@kahveciderin/concave";

// Owner-only access
auth: scopePatterns.ownerOnly("userId"),

// Public read, owner write
auth: scopePatterns.publicReadOwnerWrite("userId"),

// Owner or admin access
auth: scopePatterns.ownerOrAdmin("userId", (user) => user.metadata?.role === "admin"),

// Organization-based access
auth: scopePatterns.orgBased("organizationId"),
```

## RSQL Helpers

Build scopes programmatically:

```typescript
import { rsql, eq, ne, gt, gte, lt, lte, inList, notIn, like, notLike, isNull, isNotNull, and, or } from "@kahveciderin/concave";

// Basic equality
const scope = eq("userId", user.id);

// Pattern matching (LIKE / NOT LIKE)
const scope = like("email", "%@example.com");   // emits %=
const scope = notLike("email", "%@spam.com");   // emits !%=

// Multiple conditions (AND)
const scope = and(
  eq("status", "active"),
  eq("organizationId", user.orgId)
);

// OR conditions
const scope = or(
  eq("userId", user.id),
  eq("public", true)
);

// Template syntax (same result)
const scope = rsql`userId=="${user.id}";status=="active"`;
```

The filter grammar has no NOT combinator, so there is no `not()` helper — use the negated operators instead: `ne` (`!=`), `notIn` (`=out=`), `notLike` (`!%=`), `isNotNull` (`=isnull=false`).

## Middleware

Additional middleware helpers:

```typescript
import { requireAuth, requireRole, requirePermission, getUser } from "@kahveciderin/concave";

// Require authentication
app.get("/profile", requireAuth(), (c) => {
  return c.json(getUser(c));
});

// Require specific role
app.get("/admin", requireRole("admin"), (c) => {
  return c.json({ message: "Admin area" });
});

// Require specific permission
app.post("/posts", requirePermission("posts:create"), async (c) => {
  // ...
});
```

## Client-Side Authentication

### useAuth Hook

The `useAuth` hook provides authentication state in React and supports multiple authentication strategies:

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { useAuth } from "@kahveciderin/concave/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
});

interface User {
  id: string;
  name: string;
  email: string;
}

function App() {
  const { user, isAuthenticated, isLoading, logout, accessToken } = useAuth<User>();

  // Set global auth error handler
  useEffect(() => {
    client.setAuthErrorHandler(logout);
  }, [logout]);

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <LoginPage />;

  return (
    <div>
      <p>Welcome, {user?.name}!</p>
      <button onClick={logout}>Sign out</button>
    </div>
  );
}
```

### Auth Strategies

The `useAuth` hook supports multiple authentication strategies:

| Strategy | Description |
|----------|-------------|
| `cookie` | Session-based auth using cookies (default) |
| `jwt` | JWT bearer token auth (uses JWT client if configured) |
| `bearer` | Manual bearer token auth (provide token in options) |
| `apiKey` | API key auth (uses X-API-Key header) |
| `auto` | Auto-detect based on client configuration |

```typescript
// Cookie-based auth (default)
const { user, isAuthenticated, logout } = useAuth<User>();

// JWT auth (auto-detected if JWT client is configured)
const { user, isAuthenticated, logout, accessToken } = useAuth<User>({ strategy: "jwt" });

// Manual bearer token
const { user, isAuthenticated } = useAuth<User>({ 
  strategy: "bearer", 
  token: myBearerToken 
});

// API key auth
const { user, isAuthenticated } = useAuth<User>({ 
  strategy: "apiKey", 
  apiKey: "my-api-key" 
});

// Custom check URL (works with any strategy)
const { user } = useAuth<User>({ 
  checkUrl: "/api/auth/session",  // For Passport/NextAuth
});
```

### useAuth Options

```typescript
interface UseAuthOptions {
  checkUrl?: string;      // Custom endpoint to check auth (default: /api/auth/me)
  logoutUrl?: string;     // Custom logout endpoint (default: /api/auth/logout)
  strategy?: AuthStrategy; // Auth strategy (default: "auto")
  token?: string;         // Bearer token (for "bearer" strategy)
  apiKey?: string;        // API key (for "apiKey" strategy)
  baseUrl?: string;       // Custom base URL for auth requests
}

interface UseAuthResult<TUser> {
  user: TUser | null;                                // Current user
  status: "loading" | "authenticated" | "unauthenticated";
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  accessToken: string | null;                        // Current access token (JWT/bearer)
}
```

### JWT Auth with Client

When using JWT auth with the Concave client, the hook automatically integrates:

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { useAuth, useJWTAuth } from "@kahveciderin/concave/client/react";

// Option 1: Use createClient with jwt config
const client = getOrCreateClient({
  baseUrl: location.origin,
  jwt: {
    authPath: "/api/auth",  // JWT endpoints path
  },
});

// The useAuth hook auto-detects JWT strategy
function App() {
  const { user, isAuthenticated, accessToken } = useAuth<User>();
  // accessToken is automatically included in auth checks
}

// Option 2: Use dedicated JWT hook for full control
import { initJWTClient, useJWTAuth } from "@kahveciderin/concave/client/react";

initJWTClient({
  baseUrl: location.origin,
  authPath: "/api/auth",
});

function App() {
  const { 
    user, 
    accessToken, 
    isAuthenticated, 
    login, 
    signup, 
    logout, 
    refresh 
  } = useJWTAuth<User>();

  const handleLogin = async () => {
    await login("user@example.com", "password");
  };

  const handleSignup = async () => {
    await signup("user@example.com", "password", "John Doe");
  };
}
```

### Passport/NextAuth Compatibility

The hook works seamlessly with Passport.js and NextAuth/Auth.js session endpoints:

```typescript
// Passport adapter - uses /api/auth/session
const { user } = useAuth<User>({ 
  checkUrl: "/api/auth/session" 
});

// NextAuth/Auth.js - uses cookie-based sessions
// The hook automatically sends credentials with requests
const { user } = useAuth<User>();

// Passport with bearer token (for mobile apps, API clients)
const { user } = useAuth<User>({
  strategy: "bearer",
  token: sessionToken,
  checkUrl: "/api/auth/session",
});
```

### OIDC Adapter Compatibility

For OIDC-based authentication, the hook integrates with the auth manager:

```typescript
const client = getOrCreateClient({
  baseUrl: location.origin,
  auth: {
    issuer: "https://auth.example.com",
    clientId: "my-app",
    redirectUri: location.origin + "/callback",
  },
});

function App() {
  // Auto-detects OIDC auth when auth manager has token
  const { user, isAuthenticated, accessToken } = useAuth<User>();
  
  // accessToken contains the OIDC access token
  // which is automatically included in auth checks
}
```

### Login Form Example

```typescript
function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      window.location.reload();
    } else {
      const data = await response.json();
      setError(data.error?.message ?? "Login failed");
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">Login</button>
    </form>
  );
}
```

### JWT Authentication

For token-based auth instead of cookies:

```typescript
// Set bearer token after login
client.setAuthToken("your-jwt-token");

// Clear token on logout
client.clearAuthToken();
```

## API Endpoints

### GET /api/auth/me

Returns the current authenticated user or null.

**Response:**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "expiresAt": "2024-01-15T00:00:00.000Z"
}
```

Or when not authenticated:
```json
{
  "user": null
}
```

### POST /api/auth/login

Authenticates a user with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "sessionId": "sess_abc123"
}
```

### POST /api/auth/signup

Creates a new user account.

**Request:**
```json
{
  "email": "newuser@example.com",
  "password": "secret123",
  "name": "Jane Doe"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_456",
    "email": "newuser@example.com",
    "name": "Jane Doe"
  }
}
```

### POST /api/auth/logout

Clears the session and logs out the user.

**Response:**
```json
{
  "success": true
}
```

## Advanced: Custom Routes

If you need more control, you can use the adapter's routes directly:

```typescript
import { createPassportAdapter, createAuthMiddleware } from "@kahveciderin/concave";

const authAdapter = createPassportAdapter({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  validatePassword: async (email, password) => {
    // Custom validation logic
  },
});

// Use adapter's built-in routes (getRoutes() returns a Hono instance)
app.route("/auth", authAdapter.getRoutes());

// Or create custom routes
import { setCookie } from "hono/cookie";

app.post("/custom-login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  // Custom login logic using adapter
  const session = await authAdapter.createSession(userId);
  setCookie(c, "session", session.id, { httpOnly: true });
  return c.json({ success: true });
});
```

## Session Stores

### In-Memory (Default)

Good for development. Sessions are lost on server restart.

```typescript
import { InMemorySessionStore } from "@kahveciderin/concave";

const authAdapter = createPassportAdapter({
  sessionStore: new InMemorySessionStore(),
  // ...
});
```

### Redis

For production with multiple servers:

```typescript
import { createRedisSessionStore } from "your-redis-adapter";

const authAdapter = createPassportAdapter({
  sessionStore: createRedisSessionStore({
    url: process.env.REDIS_URL,
    prefix: "session:",
  }),
  // ...
});
```

The session store interface:

```typescript
interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
  getAll?(): Promise<SessionData[]>;  // Optional, for admin UI
}
```
