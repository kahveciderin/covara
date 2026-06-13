# Email Contracts 

Scope: `src/email/` — the `EmailAdapter` interface, the Resend and Cloudflare
Email Service adapters, and the template builder.

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
- **Errors are explicit.** A non-2xx provider response (Resend) or a rejected
  binding send (Cloudflare) throws an error naming the provider and status; it is
  never silently swallowed.

## Non-guarantees

- **No delivery guarantee / no built-in retry or queue.** `send` resolves when
  the provider accepts the request; downstream delivery is the provider's
  concern. For at-least-once delivery, send from a background task (retries +
  DLQ) rather than inline.
- **No idempotency.** Calling `send` twice sends twice. De-duplicate upstream if
  needed (e.g. an idempotency key on the triggering mutation).
- **No template storage/versioning.** The builder renders at call time; it does
  not persist or version templates.
- **Provider feature parity is not normalized** beyond the common `EmailMessage`
  fields (e.g. scheduling, provider-specific analytics are not abstracted).
