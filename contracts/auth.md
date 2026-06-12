# Authentication Contracts

## Guarantees

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
