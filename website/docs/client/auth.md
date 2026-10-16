---
id: auth
title: Client authentication
sidebar_label: Auth
description: The useAuth hook and its strategies (cookie, JWT, bearer, API key, auto), plus the OIDC PKCE flow with token refresh, storage options, and a callback page.
---

# Client authentication

The client supports several auth strategies and a full OIDC PKCE flow. The React [`useAuth`](#useauth) hook exposes the current state; the underlying [transport](./overview.md#resilient-transport) refreshes tokens and retries `401`s automatically.

## `useAuth`

```tsx
import { useAuth } from "covara/client/react";

function App() {
  const { user, status, isAuthenticated, isLoading, logout, refetch, accessToken } = useAuth<User>();
  if (isLoading) return <div>Loading…</div>;
  if (!isAuthenticated) return <LoginPage />;
  return <button onClick={logout}>Sign out {user?.name}</button>;
}
```

### Strategies

| Strategy | Description |
|----------|-------------|
| `cookie` | Session cookies (default). |
| `jwt` | JWT bearer (auto-used when the client has `jwt` configured). |
| `bearer` | Manual bearer token (`token`). |
| `apiKey` | API key via `X-API-Key` (`apiKey`). |
| `auto` | Auto-detect from client configuration (default). |

```tsx
useAuth<User>();                                        // cookie (default)
useAuth<User>({ strategy: "jwt" });
useAuth<User>({ strategy: "bearer", token });
useAuth<User>({ strategy: "apiKey", apiKey: "..." });
useAuth<User>({ checkUrl: "/api/auth/session" });       // Passport/NextAuth
```

### Options & result

```typescript
interface UseAuthOptions {
  checkUrl?: string;   // default /api/auth/me
  logoutUrl?: string;  // default /api/auth/logout
  strategy?: "cookie" | "jwt" | "bearer" | "apiKey" | "auto";
  token?: string;      // bearer
  apiKey?: string;     // apiKey
  baseUrl?: string;
  authBasePath?: string;   // default /api/auth (login/signup/verify)
  passkeyPath?: string;    // default /passkey (inside authBasePath)
  socialBasePath?: string; // default /api/auth/social
}

interface UseAuthResult<TUser> {
  user: TUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  accessToken: string | null;
  // Email/password (refresh `user` on success)
  login: (email: string, password: string) => Promise<void>;
  signup: (input: { email: string; password: string; name?: string }) => Promise<void>;
  // Email confirmation
  requestEmailVerification: (email: string) => Promise<void>;
  confirmEmail: (email: string, token: string) => Promise<void>;
  // Social (Passport) — redirects to the provider
  signInWith: (provider: string) => void;
  // Passkeys (WebAuthn)
  registerPasskey: (options?: { name?: string; signal?: AbortSignal }) => Promise<PasskeyInfo>;
  loginWithPasskey: (options?: {
    email?: string;
    mediation?: CredentialMediationRequirement;
    signal?: AbortSignal;
  }) => Promise<void>;
}
```

Set a global 401 handler to redirect on auth loss:

```tsx
useEffect(() => { client.setAuthErrorHandler(logout); }, [logout]);
```

### Email/password & social flows

The hook drives the [`useAuth` server routes](../auth/getting-started.md) directly — no hand-written `fetch`:

```tsx
const { login, signup, logout, signInWith, requestEmailVerification, confirmEmail } = useAuth<User>();

await login("a@b.com", "secret");        // refreshes `user`
await signup({ email, password, name }); // refreshes `user`
signInWith("github");                    // redirect to a social provider
```

This is the same code whether the server uses a [cookie or JWT session](../auth/sessions.md#session-strategies): with `jwtSession`, `login`/`signup` capture the returned access token and send it as a bearer automatically (cleared on `logout`).

Outside React, the same flows are first-class methods on the client:

```typescript
await client.session.signup({ email, password, name });
await client.session.requestEmailVerification(email);
await client.session.confirmEmail(email, token);
await client.session.login(email, password);
const user = await client.session.me<User>();
await client.session.logout();
client.loginWithSocial("github");
```

Both default to the `/api/auth` mount; override with `useAuth({ authBasePath })` or `createClient({ session: { basePath } })`.

For JWT login/signup/refresh control, use [`useJWTAuth`](../auth/jwt.md).

### Passkeys

When the server enables [passkeys](../auth/passkeys.md), the client runs the WebAuthn ceremonies for you: it fetches the options, converts the base64url fields to `ArrayBuffer`s for `navigator.credentials.create`/`get`, serializes the resulting credential back to JSON, and posts it to the verify route.

```tsx
const { registerPasskey, loginWithPasskey } = useAuth<User>();

await registerPasskey({ name: "MacBook" });          // signed in: add a passkey
await loginWithPasskey();                             // usernameless; refreshes `user`
await loginWithPasskey({ email: "ada@example.com" }); // email-first (security keys)
```

Outside React:

```typescript
import { isPasskeySupported, isConditionalMediationAvailable } from "covara/client";

if (isPasskeySupported()) {
  await client.session.registerPasskey({ name: "Phone" });
}
await client.session.loginWithPasskey();
const passkeys = await client.session.listPasskeys(); // [{ id, name, createdAt, lastUsedAt, ... }]
await client.session.renamePasskey(passkeys[0].id, "Work laptop");
await client.session.deletePasskey(passkeys[0].id);
```

**Autofill.** For passkey autofill (conditional UI), mark the username field with `autocomplete="username webauthn"` and start a conditional request when the page loads; abort it if the user submits the form another way:

```typescript
const controller = new AbortController();
if (await isConditionalMediationAvailable()) {
  client.session.loginWithPasskey({ mediation: "conditional", signal: controller.signal })
    .then(() => location.assign("/"))
    .catch(() => {});
}
```

With a `jwtSession` server, `loginWithPasskey` captures the returned access token exactly like `login`. Both throw when WebAuthn is unavailable (`Passkeys (WebAuthn) are not supported in this environment`) or the user cancels the browser prompt, and surface the server's problem detail on failure (e.g. `Passkey authentication failed`). The lower-level helpers `createPasskeyCredential`, `getPasskeyCredential`, `base64urlToBuffer` and `bufferToBase64url` are exported from `covara/client` for custom flows. Passkey routes default to `/api/auth/passkey`; override with `createClient({ session: { passkeyPath } })` / `useAuth({ passkeyPath })` to match the server's `passkey.basePath`.

## OIDC PKCE flow

Configure `auth` on the client to talk to an [OIDC provider](../auth/oidc-provider.md). The client handles PKCE, token refresh, and 401 retry.

```typescript
import { createClient } from "covara/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

await client.auth.login();          // redirect to the provider
await client.auth.handleCallback(); // on /callback
client.auth.isAuthenticated();
client.auth.getUser();
await client.auth.logout();

const unsubscribe = client.auth.subscribe((state) => console.log(state.status, state.user));
```

### Config

```typescript
interface OIDCClientConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  scopes?: string[];               // default ["openid","profile","email"]
  autoRefresh?: boolean;           // default true
  refreshBufferSeconds?: number;   // default 60
  storage?: TokenStorage;          // default MemoryStorage
  flowType?: "redirect" | "popup"; // default "redirect"
}
```

### Callback page

```tsx
function CallbackPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client.auth.handleCallback().then(() => location.assign("/")).catch((e) => setError(e.message));
  }, []);
  return error ? <div>Error: {error}</div> : <div>Completing sign in…</div>;
}
```

### Token storage

```typescript
import { MemoryStorage, LocalStorageAdapter, SessionStorageAdapter } from "covara/client";

auth: { storage: new MemoryStorage() }                  // default, most secure
auth: { storage: new LocalStorageAdapter("myapp_") }    // persists across tabs
auth: { storage: new SessionStorageAdapter("myapp_") }  // until tab close
```

For React Native, provide an AsyncStorage-compatible `TokenStorage` — see [React Native](./react-native.md).

## Related

- [Auth overview](../auth/overview.md) · [OIDC provider](../auth/oidc-provider.md) · [JWT](../auth/jwt.md)
- [React Native](./react-native.md)
