# Billing Contracts 

Scope: `src/billing/` — the `BillingAdapter` interface, the Stripe / Lemon
Squeezy / Paddle / Polar adapters, the `createBilling` facade, the credits
ledgers, the subscription store, webhook handling, reconciliation, and the
server router.

## Guarantees

- **Unified interface.** All four providers implement the same `BillingAdapter`
  and return normalized models (`BillingCustomer`, `BillingSubscription` with a
  canonical `SubscriptionStatus`, `CheckoutSession`, `BillingEvent`).
- **Complete listings.** `listSubscriptions(customerId)` follows provider
  pagination to the end (bounded at 1000 pages, and stops on an empty page or a
  repeated cursor). `listAllSubscriptions({ cursor })` returns one page and a
  `nextCursor` that is absent on the last page.
- **Webhook signature verification.** When a `webhookSecret` is configured,
  `handleWebhook` rejects any payload whose signature does not verify
  (`BillingWebhookSignatureError`, HTTP 400), using the provider's scheme
  (Stripe `t.payload` HMAC, Lemon Squeezy body HMAC, Paddle `ts:payload` HMAC,
  Polar Standard-Webhooks), with constant-time comparison and timestamp-skew
  rejection where the scheme includes a timestamp.
- **Seen only after success.** A delivery is claimed with a short lease
  (`webhookLeaseMs`, default 5 min) and marked done (24h window) only after the
  credit grant, `onEvent`, and the subscription-state write all succeeded. If
  any of them throws, the claim is released, `handleWebhook` rethrows, and
  `webhookHandler` answers 500 so the provider's retry is processed. A
  concurrent duplicate of an in-flight delivery gets
  `BillingWebhookInFlightError` (HTTP 409) and runs no side effects. A done
  duplicate is parsed and returned with no side effects.
- **Exactly-once credit granting per event.** On `payment.succeeded`, the matched
  plan's `credits` are granted with the ledger idempotency key
  `billing:<provider>:<event id>`. A redelivery cannot double-grant, even after
  the dedupe window lapses or the KV loses the dedupe record (for the KV ledger,
  within its idempotency TTL).
- **Durable ledger atomicity** (`createDrizzleCreditsLedger`). Each mutation
  writes one append-only entry and the balance row in a single transaction
  (atomic batch on drivers without interactive transactions, sync transaction
  on better-sqlite3). The balance row's `version` equals the newest entry's
  `seq`, and the unique `(account, seq)` index means two writers can never both
  commit against the same version. A losing writer re-reads and retries. If the
  entry insert fails, the balance update rolls back. For every account:
  `balance == Σ delta == latest balanceAfter`.
- **No overdraw.** `consume` without `allowNegative` never leaves a balance below
  zero, under any concurrency, on either ledger. It returns
  `{ ok: false, balance }` and records no entry.
- **Ledger idempotency.** `grant`/`consume`/`set` with an `idempotencyKey`
  (unique per account) apply at most once. A repeat with the same operation and
  amount returns the original result (`duplicate: true` on `consume`). A repeat
  with a different operation or amount throws `CreditsIdempotencyConflictError`
  and changes nothing. A refused (insufficient) `consume` does not consume its
  key.
- **Amount validation.** Amounts must be safe integers, and non-negative for
  `grant`/`consume`. Fractional, NaN, infinite, or negative amounts throw before
  any write. An empty account id throws.
- **Full history (durable ledger).** Every entry is retained. `historyPage`
  walks all of them newest-first with an opaque cursor.
- **Shared event pipeline.** Webhook events and reconciliation-synthesized
  events run through the same steps (plan enrichment → auto-grant → `onEvent` →
  subscription-state write), so app hooks observe them identically.
  Synthesized events carry `source: "reconcile"`.
- **Reconciliation is provider-authoritative and safe.** Remote state wins over
  local state. A provider error (after 429/5xx retries with backoff) is reported
  and never interpreted as a deletion. Only a 404 from `getSubscription` marks a
  locally known subscription canceled. A drift is applied only if the local
  record is unchanged since it was read; otherwise it is reported as
  `skipped_concurrent_update`. Synthesized event ids are deterministic in
  `(subscription, local state, remote state)`, so concurrent runs fire each
  hook once. A drift whose hook throws is not written locally and is retried
  by the next run. `dryRun` performs no writes and fires no hooks.
- **Reconcile endpoint is opt-in.** `POST /reconcile` exists only when
  `authorizeReconcile` is configured, and answers 403 when the guard denies.
- **404 → null.** `getCustomer`/`getSubscription` return `null` for not-found
  rather than throwing. Other non-OK responses throw `BillingError` with status.

## Non-guarantees

- **The KV ledger is not durable.** `createCreditsLedger` (the default when no
  `credits` is passed) keeps balances in KV, which may evict them. History is
  capped at the newest 1000 entries, and idempotency keys expire
  (`idempotencyTtlMs`, default 30 days). A refused KV `consume` may report a
  transiently low balance while other consumers are in flight. Use
  `createDrizzleCreditsLedger` as the system of record.
- **`onEvent` is at-least-once.** A failure after `onEvent` succeeded (e.g. the
  subscription-state write) releases the claim, so the retry runs `onEvent`
  again. Hooks must be idempotent on `event.id`.
- **Out-of-order webhooks.** The webhook path stores whatever subscription state
  an event carries. An older event delivered after a newer one can regress
  local state until the next reconcile run repairs it.
- **Dedupe/default stores require a global KV.** Without a KV, webhooks are still
  verified, parsed and processed, but there is no delivery dedupe, the default
  KV ledger throws, and no default subscription store exists (reconcile throws
  unless `subscriptions` is passed).
- **No provider-API drift protection.** Adapters target the providers' current
  REST APIs. A breaking provider change requires an adapter update.
- **Capability gaps are explicit, not emulated.** Where a provider lacks a
  portable capability (e.g. Paddle `reportUsage` / hosted portal), the adapter
  throws a clear `BillingError` or omits the optional method rather than faking
  it.
- **Reconciliation covers subscriptions only.** One-time payments and credit
  grants are not reconciled against the provider.
- **Account resolution is best-effort.** Auto-grant resolves the account from
  `metadata.accountId`/`userId` (set this at checkout) or the customer id. If
  neither is present, no credits are granted.
