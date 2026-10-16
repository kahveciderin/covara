---
id: passkeys
title: Passkeys (WebAuthn)
sidebar_label: Passkeys
description: Passwordless and usernameless sign-in with passkeys — a useAuth credential provider that verifies WebAuthn registrations and assertions, stores credentials in KV or your database, and issues the same session as a password login.
---

# Passkeys (WebAuthn)

Passkeys let users sign in with Face ID, Touch ID, Windows Hello, an Android phone or a hardware security key instead of a password. Covara ships them as a `useAuth` credential provider: pass a `passkey` config and the auth router gains registration, login and credential-management routes. A successful passkey login goes through the **same `completeLogin` path** as a password login, so it works unchanged with [`cookieSession`](./sessions.md#session-strategies) and [`jwtSession`](./jwt.md), fires `onLogin`, and issues the CSRF token.

Verification is done by [`@simplewebauthn/server`](https://simplewebauthn.dev/), which is built on WebCrypto and runs on Node and Cloudflare Workers alike (no Node built-ins).

```typescript
import { useAuth, cookieSession, createDrizzlePasskeyStore } from "covara";

const auth = useAuth({
  session: cookieSession({ getUserById }),
  login: { validateCredentials },
  passkey: {
    rpId: "app.example.com",               // your registrable domain
    rpName: "Example",                     // shown by the browser
    origin: "https://app.example.com",     // or an array of allowed origins
    store: createDrizzlePasskeyStore({ db }),
    findUserByEmail: (email) => db.query.users.findFirst({ where: eq(users.email, email) }),
  },
});
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `rpId` | — (required) | Relying-party ID: the domain passkeys are scoped to (`localhost` in development). |
| `rpName` | — (required) | Human-readable name shown in the browser prompt. |
| `origin` | — (required) | Allowed origin(s) of the page running the ceremony, e.g. `https://app.example.com`. Every response's `clientDataJSON.origin` must match one exactly. |
| `store` | — (required) | A [`PasskeyStore`](#storage): `createDrizzlePasskeyStore`, `createKVPasskeyStore` or `InMemoryPasskeyStore` (tests only). |
| `challengeStore` | KV if a global KV is set, else memory | Where single-use challenges live (see [Challenges](#challenges)). |
| `challengeTtlMs` | `300000` (5 min) | Challenge lifetime; also sent as the ceremony `timeout`. |
| `userVerification` | `"preferred"` | `"required"` rejects any response whose UV flag is unset (biometric/PIN). `"preferred"`/`"discouraged"` only require user presence. |
| `residentKey` | `"preferred"` | Ask authenticators for a discoverable credential so [usernameless login](#login) works. |
| `authenticatorAttachment` | unset | `"platform"` or `"cross-platform"` to steer which authenticator the browser offers. |
| `findUserByEmail` | unset | Enables `{ email }` on `/passkey/login/options` (credentials of that account are returned as `allowCredentials`). |
| `getUserName` | `user.email ?? user.name ?? user.id` | The account name shown in the browser's passkey picker. |
| `maxPerUser` | unlimited | Refuse new registrations past this count (409). |
| `basePath` | `"/passkey"` | Where the routes mount under the auth router. |
| `cost` | `{ options: 0, failed: 0 }` | [Abuse-protection](../tooling/abuse-protection.md) budget costs. |
| `pow`, `captcha` | unset | Always-on proof-of-work / CAPTCHA gates on the unauthenticated routes. |
| `onRegister(passkey, user, c)` | unset | Called after a passkey is stored. |
| `onCounterRegression(info, c)` | unset | Called when a correctly signed assertion's signature counter did not advance (likely a cloned authenticator). The login is rejected either way. |

## Routes

Mounted under the auth router (e.g. `/api/auth`) at `basePath`:

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/passkey/register/options` | POST | signed in | `PublicKeyCredentialCreationOptionsJSON` for `navigator.credentials.create`. Existing credentials are listed in `excludeCredentials`. |
| `/passkey/register/verify` | POST | signed in | Body `{ response, name? }`. Verifies the attestation and stores the credential. Returns `{ passkey }`. |
| `/passkey/login/options` | POST | — | Body `{ email? }`. `PublicKeyCredentialRequestOptionsJSON` for `navigator.credentials.get`. |
| `/passkey/login/verify` | POST | — | Body `{ response }`. Verifies the assertion and issues a session exactly like `/login`. |
| `/passkey/credentials` | GET | signed in | `{ passkeys: PasskeySummary[] }` for the current user (public keys are never returned). |
| `/passkey/credentials/:id` | PATCH | signed in | Body `{ name }`. Rename one of your passkeys. |
| `/passkey/credentials/:id` | DELETE | signed in | Remove one of your passkeys. Another user's id is a 404. |

`response` is the JSON form of the `PublicKeyCredential` (base64url fields), as produced by the [client helpers](../client/auth.md#passkeys), `@simplewebauthn/browser`, or the browser's native `credential.toJSON()`.

### Registration

A passkey is always added to an **existing, signed-in** account: sign the user up or in first (password, [magic link](./magic-links.md), [social](./social.md)…), then call `registerPasskey()`. Each user gets one random, opaque WebAuthn user handle (never their id or email) that is reused for every passkey they add.

Registration fails with **400** if the challenge is unknown, expired, already used, issued to a different user or issued for login; if the origin, RP ID or `clientData.type` don't match; if user presence is missing (or user verification when `userVerification: "required"`); or if the attestation doesn't verify. A credential id that is already registered — to the same or another account — is a **409**.

### Login

- **Usernameless** (default): call `/passkey/login/options` with no body. `allowCredentials` is empty, the browser offers every discoverable passkey for the RP, and the server finds the account from the credential id.
- **Email-first**: with `findUserByEmail` configured, `{ email }` returns that account's credentials as `allowCredentials` (needed for non-discoverable security keys) and **binds the challenge to that account**: a passkey of any other account is rejected. An unknown email gets the same response shape (and a challenge that no credential can satisfy), so the endpoint does not reveal which emails exist — beyond the presence of `allowCredentials` for accounts that do have passkeys.
- **Autofill (conditional UI)**: pass `mediation: "conditional"` from the client and add `autocomplete="username webauthn"` to your username input.

Every failure on `/passkey/login/verify` — unknown/expired/replayed challenge, unknown or deleted credential, a `userHandle` that doesn't belong to the credential, wrong origin or RP ID, missing user presence/verification, a bad signature, a signature-counter regression, or an account that no longer exists — returns the same **401** `Passkey authentication failed`, so the response is not an oracle.

## Challenges

Every options call mints a fresh random challenge and stores it with its purpose (`registration` / `authentication`), expiry and binding (the registering user, or the email-scoped account). Verify extracts the challenge from `clientDataJSON` and **consumes** it before anything else, so a challenge is single-use even when verification then fails.

When a global KV is configured (`setGlobalKV`, Redis, Durable Object) challenges go to KV under `covara:passkey:challenge:*` with a TTL, so the options and verify requests can land on different processes or Workers isolates. Consumption relies on `del` returning the number of deleted keys, so only one of several concurrent verifies of the same challenge wins. Without a global KV an in-memory store is used (single process only). Pass `challengeStore` to supply your own `PasskeyChallengeStore` (`set(challenge, data, ttlMs)` / `consume(challenge)`).

## Signature counter

Authenticators that implement a signature counter increment it on every use. Covara stores it and rejects any correctly signed assertion whose counter is not strictly greater than the stored one (unless both are `0` — many synced passkeys never count), calling `onCounterRegression` so you can alert or disable the credential. The check runs only after the signature is proven, so forged assertions never trigger the hook.

## Storage

```typescript
interface PasskeyStore {
  create(passkey: StoredPasskey): Promise<void>;   // must reject a duplicate id
  findById(id: string): Promise<StoredPasskey | null>;
  listByUser(userId: string): Promise<StoredPasskey[]>;
  update(id: string, patch: PasskeyUpdate): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- **Drizzle** — `createDrizzlePasskeyStore({ db })` uses the `auth_passkeys` [internal table](./internal-tables.md#auth_passkeys) (created by `migrateInternal`; the dialect is detected from `db`). For your own table or column names pass `resolver: defineInternalSchema({ passkeys: { table, fieldMap } }).passkeys`.
- **KV** — `createKVPasskeyStore(kv)` stores one JSON entry per credential plus a per-user index set.
- **Memory** — `InMemoryPasskeyStore` for tests.

Public keys are stored as base64url COSE keys; the counter is a 32-bit unsigned integer (`BIGINT` on Postgres).

## Abuse protection and throttling

The unauthenticated routes integrate with [abuse protection](../tooling/abuse-protection.md) the same way password login does:

- `/passkey/login/options` charges `cost.options` (operation `auth.passkey.options`) — it writes a challenge, so it is worth metering.
- `/passkey/login/verify` charges `cost.failed` **only when the attempt fails** (operation `auth.passkey.login`, deferred like `auth.login`). Over budget, the client gets a 428 PoW (or CAPTCHA) challenge, or a 429 when PoW is disabled.
- With `useAuth({ throttle: true })`, failed passkey logins are counted per credential id and per IP by the same [login throttle](./account-security.md) and reset on success.

## Client

```typescript
const client = createClient({ baseUrl: location.origin, credentials: "include" });

await client.session.registerPasskey({ name: "MacBook" });          // while signed in
await client.session.loginWithPasskey();                             // usernameless
await client.session.loginWithPasskey({ email: "ada@example.com" }); // email-first
const passkeys = await client.session.listPasskeys();
await client.session.deletePasskey(passkeys[0].id);
```

React's `useAuth()` exposes `registerPasskey()` and `loginWithPasskey()`. See [Client auth → Passkeys](../client/auth.md#passkeys).

## Related

- [Sessions](./sessions.md) · [Internal tables](./internal-tables.md) · [Account security](./account-security.md) · [Abuse protection](../tooling/abuse-protection.md)
- [Auth contract](../contracts/auth.md#passkeys-webauthn) — the passkey invariants
