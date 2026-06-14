# Authentication Contracts

## Guarantees

### Session strategy decoupling
- **Orthogonal to credentials**: `useAuth`'s `session` strategy (how the identity is persisted/validated/issued) is independent of the credential providers (`login`/`signup`/`social`/`verification`/`mfa`/`magicLink`). Any provider composes with any strategy — e.g. a Passport social provider issuing JWTs.
- **Single issuance path**: every successful login (password, social, magic link, signup) goes through `strategy.issue(c, userId)`; the auth middleware authenticates every request through `strategy.authenticate(c)`. `cookieSession` mints a server-side session + cookie; `jwtSession` mints a bearer access token + refresh cookie and exposes `/refresh`.
- **Back-compat**: a legacy `adapter` passed to `useAuth` is mapped to a session strategy internally, preserving its prior behavior.

### Token Validation
- **Required claims checked**: `iss`, `aud`, `exp` are always validated
- **Algorithm enforcement**: Only configured algorithms accepted; `none` always rejected
- **Clock skew tolerance**: Configurable tolerance for `exp`, `nbf`, `iat` checks
- **Signature verification**: All tokens are cryptographically verified

### OIDC Compliance
- **Discovery support**: `/.well-known/openid-configuration` endpoint provided
- **PKCE required**: Public clients must use PKCE (code_challenge); `security.pkce.required` extends this to all clients
- **PKCE plain rejected**: `code_challenge_method=plain` is always rejected; only `S256` is supported and advertised
- **State validation**: `state` parameter validated on callback
- **Revocation (RFC 7009)**: `POST /revoke` invalidates a refresh token after client authentication
- **Introspection (RFC 7662)**: `POST /introspect` reports `{ active }` and claims for access/refresh tokens after client authentication
- **Client secret hashing**: Stored secrets prefixed `scrypt$` are verified with scrypt; plaintext secrets are compared in constant time

### OIDC Hardening
- **Redirect URI component validation**: `redirect_uri` is matched component-by-component (protocol, host, port, normalized path, and query/fragment when registered), never by prefix; an unregistered URI is rejected with `400` before any redirect is issued
- **Federated id_token verification**: external `id_token`s are signature-verified against the provider's JWKS (issuer + audience checked), the nonce is compared to the stored interaction nonce, and the `id_token` `sub` is cross-checked against the `userinfo` `sub`
- **External login resumes the interaction**: a successful external callback (federated OIDC or `backends.passport`) establishes the provider session and continues the pending `/authorize` interaction to consent or the authorization-code redirect — the same completion path as email/password login; it never returns the user as a bare JSON body
- **Passport backend state binding**: `backends.passport` carries the OAuth `state`/PKCE handle across the redirect→callback in a signed, `httpOnly`, short-lived cookie + state store; a callback with missing/expired/mismatched state is rejected before any token exchange
- **Correct at_hash**: the `id_token` `at_hash` claim is the left-half of the hash matching the signing algorithm, computed whenever an access token is issued
- **Endpoint rate limiting**: `/token`, `/jwks`, `/introspect` rate-limited per client/IP when `security.rateLimiting` is configured (KV-backed when a global KV exists)
- **Persistent stores by default**: clients, codes, refresh tokens, consents, interactions, and state are KV-backed (with expiry-derived TTLs) whenever a global KV is registered; `stores.type: "memory"` forces in-memory
- **Dynamic registration is opt-in**: `POST /register` returns `404` unless `registration.enabled` is true; an `initialAccessToken`, when set, is required as a Bearer token
- **Consent revocation + TTL**: `POST /consent/revoke` clears a user's consent (one client or all) for an authenticated session; stored consents expire after `security.consent.ttlSeconds` (default 1 year)
- **login_hint escaping**: dynamic values in the default login template are HTML-escaped

### Account Security Flows (opt-in via `useAuth`)
- **Password policy**: when `passwordPolicy` is set, weak passwords are rejected with `422` on `POST /signup` and `POST /password/reset`; a built-in denylist of common passwords is enabled by default
- **MFA/TOTP**: `mfa` adds `/mfa/enroll`, `/mfa/enroll/confirm`, and `/mfa/verify`; enrollment is two-step (created disabled, then confirmed). With `requireOnLogin`, `/login` returns `{ mfaRequired: true }` (`401`) for enrolled users until a valid TOTP or single-use backup code is supplied; a used backup code triggers `consumeBackupCode`
- **Magic links**: `magicLink` adds `/magic-link/request` (always returns `{ success: true }`, anti-enumeration) and `/magic-link/verify` (single-use token, creates the session)
- **API keys**: `createApiKey`/`verifyApiKey`/`rotateApiKey`/`revokeApiKey` store only a hash of the key; the raw key (`[prefix_]<id>.<secret>`) is returned once; verification returns a typed `reason` (`not_found`/`expired`/`mismatch`) on failure

### Field-Level Write Enforcement (mass-assignment protection)
- **Enforced allowlist**: when `fields.writable` is configured, any table column not in the list is stripped from create/update bodies (single, batch, and `POST /batch/upsert`) before hooks and the database see it
- **Exemptions**: the primary key and `generatedFields` are never stripped; non-column keys (relation payloads) pass through
- **Hook precedence**: stripping happens before lifecycle hooks, so a server-side hook can still set protected fields
- **strictInput**: with `strictInput: true`, unknown fields are rejected with `422` instead of being silently ignored

### Password Storage
- **Scrypt hashing**: `hashPassword` derives a self-describing `scrypt$N=..,r=..,p=..$salt$hash` string with a per-hash random salt
- **Constant-time verification**: `verifyPassword` compares using `timingSafeEqual` and returns `false` for any unparseable input
- **Rehash signalling**: `needsRehash` returns `true` when stored parameters are weaker than the target (or the hash is unparseable)

### Session Security
- **Session rotation**: Session ID rotated on login (prior session invalidated, prevents fixation)
- **Logout invalidation**: All session tokens invalidated on logout
- **Bulk invalidation**: Adapters may implement `invalidateUserSessions(userId, exceptSessionId?)`; password reset uses it when `logoutEverywhere` is set
- **Indexed bulk invalidation**: When the session store implements the per-user index (`getByUser`/`deleteByUser` — the Redis, Drizzle, and in-memory stores all do), bulk invalidation touches only that user's sessions; the scan-all `getAll()` path is a fallback for stores without the index
- **Session activity metadata**: Login/signup store the client IP and user agent in `session.data` (`ipAddress`, `userAgent`); session use stamps `session.data.lastActiveAt`, throttled to at most one persisted write per minute per session and fire-and-forget (activity tracking never blocks or fails auth)
- **Cookie security**: HttpOnly, Secure (in production), SameSite attributes set

### Multi-Tenant
- **Issuer isolation**: Same `sub` from different `iss` = different users
- **Issuer whitelist**: Only configured issuers accepted

### Field-Level Read Masking
- **Allowlist semantics**: When `fields.readable` is configured on a resource, only the listed table columns may appear in any response
- **Universal application**: Masking applies to list, get, create, update, batch, and search responses, plus every subscription event (`existing`, `added`, `changed`) and the initial subscription snapshot
- **No client bypass**: A hidden column cannot be recovered via `?select=` or by subscribing — masking is enforced server-side after projection
- **Column-only**: Only table columns are stripped; relation keys, computed values, and internal markers (`_etag`, `_optimisticId`) pass through

### Relation Scope Enforcement
- **Included relations respect target scope**: On the read path (`GET /` and `GET /:id` with `?include=`), each included relation AND-s the target resource's `read` scope (resolved for the effective/impersonated user) into its query — a relation cannot return rows the user could not read directly
- **Deny semantics**: A user denied read on the target resource yields `null` (`belongsTo`/`hasOne`) or an empty array (`hasMany`/`manyToMany`) for that relation; out-of-scope rows are filtered, not just hidden
- **Applies to discovered relations**: Auto-discovered (`autoRelations`) relations use the same enforced loader as explicit ones
- **Unregistered targets**: Relations to tables not registered as resources have no scope to enforce (no resolver) — these are an explicit author choice
- **Applies to subscriptions**: Relations embedded in subscription events (`existing`, `added`, `changed`) are scope-filtered **per subscriber** — the subscriber's user is captured at subscribe time, and on every push the target resource's `read` scope is resolved for that user and AND-ed into the included relation, with the same deny semantics as the read path. A subscriber can never receive related rows it could not read directly. Relations are loaded per subscriber rather than shared across them (cost scales with subscriber count; loads are deduplicated per subscriber within a single push)

### Internal Schema & Stores
- **Logical contract is stable**: `SessionData` (`id`/`userId`/`createdAt`/`expiresAt`/`data`) is always exposed in logical keys regardless of the underlying column names; remapping (`defineInternalSchema` `fieldMap`) applies only at the SQL persistence boundary — see [Internal tables](../auth/internal-tables.md)
- **Fail-fast validation**: `defineInternalSchema` validates that every required logical key resolves to a column on the supplied table at construction time, never at query time
- **Defaults are unchanged**: with no `internalSchema`, the built-in tables and the byte-for-byte original migration DDL are used; `createCovara({ internalSchema })` is for migration/introspection and never silently rewires a pre-built store
- **Migration safety**: generated DDL (`migrateInternal` mode c) covers single-primary-key tables only and throws for compound-PK tables (`auth_accounts`, `auth_verification_tokens`) rather than emitting an incorrect schema; `managedExternally: true` makes migration a no-op
- **KV session store is backend-agnostic**: `createKVSessionStore` works over any KV adapter; its hash field names are a private serialization, never user-facing, and are not remappable
- **Users/files are app-owned**: the framework never owns a users table (reached via `getUserById`) or a files table (supplied to `fileResource`); the changelog and rate limits are KV/memory-backed, not database tables

### Observability Storage
- **Defaults preserve behavior**: the audit log, request/error logs, and metrics are append-only logs backed by an in-memory ring buffer when no KV is configured — identical to before; with a global KV they persist automatically
- **`append` never throws**: a failing storage backend can never break the audited/served action; the in-memory mirror always records the entry even if a KV write fails
- **`setAdminAuditSink` is write-only**: it runs alongside the adapter and is for forwarding only; durable read/query/export requires an `ObservabilityLogAdapter`
- **Cross-process reads**: in KV mode synchronous reads reflect only the local process mirror; authoritative cross-instance reads use the async `query()`/`export()` path

### Admin Scope Bypass (Admin UI)
- **Identity re-verification, no secret**: The resource layer skips per-resource auth scopes only when the request carries the `x-covara-admin-bypass` marker **and** its authenticated user (or forwarded admin `apiKey`) passes the registered admin predicate. The marker is not a secret and grants nothing on its own
- **Leaked marker is inert**: A non-admin presenting the marker is served under normal scope enforcement (fail-closed); the marker value is constant and confers no authority
- **Disabled by default**: Bypass is inert unless an admin predicate is registered, which happens only when the [admin UI](../tooling/admin-ui.md) is mounted via `createCovara`; standalone `useResource` never bypasses
- **Gated on admin auth**: The admin predicate is derived from the UI's `security` config — locking down the UI's auth locks down bypass
- **Audited**: Every bypassed API-explorer request is recorded in the admin audit log (`api_explorer_execute`)

### Admin Impersonation (Admin UI)
- **Runs as the target, under their scope**: A request carrying the `x-covara-impersonate: <userId>` marker resolves the impersonated user's per-operation scope and attributes writes to them — it does NOT grant `allScope()`
- **Identity re-verification, no secret**: The marker is honored only when the forwarded request's real authenticated user passes the admin predicate (same test as bypass) and a `userManager`-backed resolver yields the target user; a forged/leaked marker from a non-admin is inert
- **Replaces bypass, never stacks**: When impersonation is active the scope layer uses the impersonated user's scope and skips the bypass branch entirely — impersonating an admin yields only that admin's scope, never full bypass (no escalation)
- **Single effective-user swap**: A middleware swaps `c.get("user")` to the impersonated user once, so scope, write attribution, and hooks all observe the same identity; admin-UI routes (`/__covara/*`) are exempt so admin authorization is unaffected
- **Audited with both ids**: Every impersonated action records the real admin id and the impersonated user id (`impersonate_execute`, `data_explorer_list`)

## Non-Guarantees

### Token Lifetime (What We Don't Promise)
- ❌ **Minimum lifetime**: Tokens may be revoked at any time
- ❌ **Refresh success**: Refresh tokens may be revoked or expired
- ❌ **Grace period**: No grace period after token expiration

### Availability (What We Don't Promise)
- ❌ **JWKS availability**: JWKS endpoint may be temporarily unavailable
- ❌ **Session persistence**: Sessions may be cleared (e.g., server restart with memory store)

## Threat Model

### In Scope (Protected Against)
- Token forgery
- Token replay (with nonce)
- Session fixation
- CSRF (with state parameter)
- Algorithm confusion attacks
- JWT injection via `none` algorithm
- Mass assignment (via enforced `fields.writable`)
- Open redirect via `redirect_uri` (component-wise validation)
- PKCE downgrade (plain rejected, required for public clients)
- Federated id_token forgery (signature + nonce + sub cross-check)
- Stored-XSS via login_hint (HTML-escaped)

### Out of Scope (Not Protected Against)
- Compromised signing keys (operational security)
- Client-side token theft (XSS)
- Phishing attacks
- Brute force (rate limiting helps but doesn't eliminate)
- Side-channel attacks

## Rate Limiting

### Auth Endpoints
- Login: 5 attempts per 15 minutes per IP
- Token refresh: 10 per minute per user
- Password reset: 3 per hour per email

### Rate Limit Bypass Protection
- Header normalization (case-insensitive)
- IP normalization (IPv4/IPv6)
- X-Forwarded-For only from trusted proxies

## Failure Modes

### Invalid Token
- Returns 401 Unauthorized
- Clear error message (without leaking info)
- No retry (client must re-authenticate)

### JWKS Unavailable
- Use cached keys if available
- Return 503 if no cached keys
- Automatic retry with backoff

### Session Expired
- Returns 401 Unauthorized
- Client should redirect to login
- Refresh token may still be valid

## Test Coverage

- `tests/invariants/auth-hardening.test.ts` - Security edge cases
- `tests/auth.test.ts` - Basic authentication
- `tests/auth-routes.test.ts` - Auth endpoints
- `tests/oidc/provider.test.ts` - OIDC provider
