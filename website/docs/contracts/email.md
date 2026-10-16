# Email Contracts 

Scope: `src/email/` — the `EmailAdapter` interface, the Resend and Cloudflare
Email Service adapters, the durable delivery wrapper (`durable.ts`), typed
delivery errors (`errors.ts`), and the template builder; plus how the auth flows
in `src/auth/routes.ts` / `email-delivery.ts` send.

## Guarantees

- **Adapter uniformity.** Every adapter implements the same `EmailAdapter`
  (`send`, optional `sendBatch`) and accepts the same `EmailMessage`. Address
  inputs (`string`, `{ email, name }`, or arrays) normalize identically via the
  shared helpers.
- **Builder output is escaped.** All caller-supplied content passed to the
  template builder is HTML-escaped before rendering; the only unescaped path is
  the explicit `.raw(html, text)` block, which is the caller's responsibility.
- **Builder produces both representations.** `.build()` always returns both
  `html` and a plaintext `text` fallback.
- **Workers-safe.** Resend uses `fetch`; the Cloudflare adapter uses the Email
  Service binding via structural types (no `@cloudflare/workers-types` import).
- **Errors are explicit and typed.** A non-2xx provider response (Resend), a
  network failure, or a rejected binding send (Cloudflare) throws an
  `EmailDeliveryError` naming the provider, with `status` (when HTTP),
  `retryAfterMs` (parsed from `Retry-After`, seconds or HTTP-date), and
  `permanent`. `4xx` other than `408/409/425/429` is permanent; everything else
  (including errors that are not `EmailDeliveryError`) is transient.
- **Idempotency key pass-through.** `send(message, { idempotencyKey })` reaches
  the adapter; Resend sends it as the `Idempotency-Key` header (single and
  batch). `sendEmailBatch` without a native batch API derives `<key>:<index>`.

### Durable delivery (`durableEmail` / `createDurableEmailAdapter`)

- **Queued send returns before the provider is contacted.** With a `queue`,
  `send` resolves `{ id: <messageId>, provider, status: "queued", taskId }`
  after enqueuing one `covara.email.send` task; the inner adapter is called only
  by the task handler.
- **Classification drives retries.** Permanent errors are never retried and go
  straight to the task DLQ. Transient errors retry with exponential backoff up
  to `retry.maxAttempts` (default 6), then go to the DLQ.
- **`Retry-After` wins over backoff.** When the error carries `retryAfterMs`, the
  next attempt is scheduled that far out (KV worker: `scheduledFor`; Cloudflare
  Queues: `delaySeconds`, capped at 12h), capped at `retry.maxRetryAfterMs`.
- **`onDeliveryFailed` fires exactly once per dead-lettered message**, on the
  attempt that dead-letters it (permanent error, or `ctx.attempt >= maxAttempts`).
  Hook errors are swallowed and never affect DLQ persistence.
- **Every message has an idempotency key** (caller-supplied or a random UUID; it
  is also the returned message id). Enqueuing a key whose task is still pending
  returns the existing task id. When a KV is available (explicit `kv`, else the
  global KV), a sent-marker is written immediately after the provider accepts
  and checked before every attempt, so a re-run (retry, DLQ replay, duplicate
  enqueue, crash after the marker) does not re-send. A marker write failure does
  not fail the task.
- **Payload bound.** A queued message whose serialized form exceeds
  `maxPayloadBytes` (default 120,000) is rejected at `send` with a permanent
  `EmailDeliveryError` (`code: "payload_too_large"`); nothing is enqueued.
- **Serialization is JSON-safe.** `Uint8Array` attachment content is stored as
  base64 with an `encoding: "bytes"` tag and restored to bytes before the
  adapter is called; string content passes through unchanged.
- **No-queue fallback.** Without `queue`, `send` delivers inline with bounded
  retries (`inline.maxAttempts`, default 3; a `Retry-After` above
  `inline.maxRetryAfterMs` stops retrying), logs a one-time "not durable"
  warning per adapter instance, fires `onDeliveryFailed` with `mode: "inline"`
  and rejects when all attempts fail.

### Auth flows

- **Enumeration-sensitive endpoints never fail on delivery.**
  `POST /password/forgot` and `POST /magic-link/request` catch any delivery
  error (callback, composed send, missing adapter, enqueue failure), report it to
  `email.onDeliveryError` (default: `console.error` without the identifier or
  token) and return the same `{ success: true }` as for an unknown address.
  `POST /verify/request` still propagates delivery errors.
- **Composed auth emails are idempotent per token.** `composeEmail` messages are
  sent with `idempotencyKey = auth:<flow>:<sha256(token)>`; the raw token never
  appears in the key.
- **Misconfiguration fails at setup.** A flow with neither its callback nor
  `composeEmail` makes `useAuth` throw.

## Non-guarantees

- **Plain adapters are best-effort.** A bare adapter's `send` makes one attempt
  and resolves when the provider accepts; wrap it with `durableEmail` + a queue
  for retries and a DLQ. Downstream delivery (inbox placement, bounces) is the
  provider's concern in every mode.
- **Exactly-once is not guaranteed.** Durable delivery is at-least-once. A
  worker that crashes after the provider accepted but before the sent-marker is
  written will re-send on retry; Resend dedupes that via `Idempotency-Key`
  (within Resend's 24h window), the Cloudflare adapter does not. Without any KV
  there is no sent-marker at all.
- **Multi-recipient Cloudflare sends are not atomic.** The Cloudflare adapter
  sends one envelope per recipient; a transient failure part-way through retries
  the whole message, so earlier recipients may receive it twice.
- **The inline fallback is not durable.** A process crash or exhausted retries
  loses the message (after reporting it to `onDeliveryFailed`).
- **Plain `send` without a key is not deduplicated.** Calling a bare adapter's
  `send` twice sends twice; durable sends without a caller key get a fresh
  random key each time.
- **No template storage/versioning.** The builder renders at call time; it does
  not persist or version templates.
- **Provider feature parity is not normalized** beyond the common `EmailMessage`
  fields (e.g. scheduling, provider-specific analytics are not abstracted).

## Test coverage

- `tests/email/errors.test.ts` — `Retry-After` parsing, status classification, typed adapter errors, `Idempotency-Key` header
- `tests/email/durable.test.ts` — queued/inline delivery, retries, DLQ, hook, Retry-After, dedupe, payload limit, attachment round-trip, Cloudflare Queues
- `tests/email/global.test.ts` — global helpers forward idempotency keys
- `tests/auth/email-delivery.test.ts` — auth flows: enumeration-safe failures, composed sends, durable mode, setup validation
