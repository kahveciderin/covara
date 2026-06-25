# Abuse Protection Contracts

Scope: `src/abuse/` (budget token bucket, config, unified enforcement, resource
middleware) and `src/pow/` (isomorphic core + server issuance/verification).
Abuse protection is a cost-weighted budget with proof of work as the overflow
valve; an endpoint may additionally require PoW unconditionally.

## Guarantees

### Enforcement model
- **Budget first, PoW as overflow.** A request's `cost` is assessed against the
  identity's token bucket. Within budget → served and debited. Over budget →
  a `428` PoW challenge (the overflow valve), unless PoW is disabled.
- **PoW disabled → hard 429.** When `pow.enabled === false`, budget exhaustion
  raises `RateLimitError` (429) with a refill-derived `Retry-After`; no challenge
  is issued.
- **Always-on endpoint PoW.** An endpoint's `pow` opt-in requires a challenge on
  every matching request regardless of budget. The effective difficulty is the
  **max** of the endpoint gate and the budget-overflow gate.
- **Order per resource:** `config.rateLimit` → abuse enforcement.

### Budget (token bucket)
- **Cost-weighted, explicit opt-in.** Only declared costs are charged;
  unannotated operations cost 0.
- **Per identity class.** Default: `authenticated` (keyed by user id) when a user
  is present, else `anonymous` (keyed by client IP). Buckets are isolated per
  class+key.
- **Refill never exceeds capacity.** Tokens accrue at `refillPerMinute`, clamped
  at `capacity`; a never-before-seen key starts full.
- **Assess before charge.** The bucket is inspected (not debited) to decide
  whether a request is within budget, so a challenged-but-unsolved request is
  **never charged**.
- **Solving pays the overdraft.** When an over-budget request's challenge is
  solved, the bucket is debited **to a floor of zero** (never negative); the
  next over-budget request is challenged again. Work does not credit tokens
  back.
- **Deferred charge for failed login.** `login.cost.failed` is gated before
  credential validation but committed only on an actual failed attempt
  (invalid credentials or invalid MFA). Successful logins (and
  valid-credentials-but-MFA-required) are not charged.
- **Storage.** KV-backed (global KV or an injected store) with an in-process
  memory fallback; single-process only without a KV.

### Proof of work
- **Stateless verification.** A solution is accepted iff: HMAC signature valid
  (timing-safe), not expired, request fingerprint recomputes to the embedded
  value, and the digest meets the embedded difficulty. No storage is consulted
  to verify.
- **Request binding.** The challenge embeds a fingerprint of
  `method + path(+query) + body hash`; a solution is valid only for the exact
  request it was issued for.
- **One-time use.** Each nonce is consumed in a short-TTL replay cache (KV
  `INCR` or memory fallback) on first successful use; replays within the TTL are
  rejected and re-challenged.
- **Difficulty hook.** Difficulty is resolved per gate (`reason` is `"endpoint"`
  or `"budget"`); the hook receives `baseDifficulty` and, for the budget gate,
  `cost`/`available`/`deficit`. Returning **0 skips the gate** (trusted caller).
  Verification always checks against the difficulty embedded at issue time.
- **Secret resolution.** `pow.secret` → `COVARA_POW_SECRET` env → random
  per-process (dev only, warns; does not verify across processes/restarts).

### CAPTCHA (beta)
- **Human-in-the-loop.** The client cannot auto-solve a CAPTCHA; verification is
  delegated to a provider (Turnstile/hCaptcha/reCAPTCHA/custom).
- **Fail-closed verification.** Any network/parse error or a falsy provider
  result rejects the token; reCAPTCHA v3 additionally enforces `minScore` and an
  optional `action`.
- **Gate or overflow.** A CAPTCHA gate fires when an endpoint opts in
  (always-on or via a `required` hook) or when the budget overflows and the
  effective `overflow` is `"captcha"`. **CAPTCHA takes precedence over PoW** when
  both apply to one request.
- **Overflow fallback.** `overflow: "captcha"` with no configured/enabled CAPTCHA
  provider falls back to PoW overflow, then to a hard 429.
- **Single-use.** Provider tokens are single-use server-side (no local replay
  cache is required).
- **Solving pays the overdraft.** Like PoW, a solved over-budget CAPTCHA debits
  the bucket to a floor of zero.

### Wire protocol
- PoW challenge: status `428`, RFC 7807 body with `code: "PROOF_OF_WORK_REQUIRED"`,
  headers `Covara-Challenge-Type: pow`, `Covara-PoW-Challenge`,
  `Covara-PoW-Difficulty`, `Covara-PoW-Algorithm`; solution echoes
  `Covara-PoW-Challenge` + `Covara-PoW-Nonce`. Only `sha256` is supported.
- CAPTCHA challenge: status `428`, `code: "CAPTCHA_REQUIRED"`, headers
  `Covara-Challenge-Type: captcha`, `Covara-Captcha-Provider`,
  `Covara-Captcha-Sitekey`, optional `Covara-Captcha-Action`; the client replies
  with `Covara-Captcha-Token`.
- `Covara-Challenge-Type` disambiguates the two 428 challenge kinds.

### Client transparency
- The transport solves a `428` PoW challenge and retries automatically, bounded
  by `pow.maxAttempts` (default 3). Enabled by default; `pow.enabled === false`
  opts out.
- A `428` CAPTCHA challenge is retried only when a `captcha.solve` callback is
  registered (bounded by `captcha.maxAttempts`, default 2); otherwise it surfaces
  as a `TransportError` with `isCaptchaRequired() === true`. The React
  `<CovaraCaptcha/>` registers a solver that renders the provider widget.
- A `429` (budget or conventional rate limit) is propagated and **never**
  auto-retried; only `428` is solved. `401` still triggers the one-shot auth
  refresh.

## Non-guarantees
- **SSE is not PoW-gated in-band.** `EventSource` cannot carry the solution
  headers; subscriptions may be budget-gated at handshake time only.
- **Budget atomicity.** The assess/deduct read-modify-write mirrors the existing
  rate-limit store and is not strictly atomic under cross-process contention.
- **Replay protection is bounded by the challenge TTL.** After expiry the nonce
  is forgotten (and the challenge is expired anyway).
