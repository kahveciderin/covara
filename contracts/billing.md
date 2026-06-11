# Contract: Billing

Scope: `src/billing/` — the `BillingAdapter` interface, the Stripe / Lemon
Squeezy / Paddle / Polar adapters, the `createBilling` facade, the credits
ledger, the webhook handling, and the server router.

## Guarantees

- **Unified interface.** All four providers implement the same `BillingAdapter`
  and return normalized models (`BillingCustomer`, `BillingSubscription` with a
  canonical `SubscriptionStatus`, `CheckoutSession`, `BillingEvent`).
- **Webhook signature verification.** When a `webhookSecret` is configured,
  `handleWebhook` rejects any payload whose signature does not verify, using the
  provider's scheme (Stripe `t.payload` HMAC, Lemon Squeezy body HMAC, Paddle
  `ts:payload` HMAC, Polar Standard-Webhooks), with constant-time comparison and
  timestamp-skew rejection where the scheme includes a timestamp.
- **Idempotent webhook processing.** Deliveries are de-duplicated by event id via
  the KV (24h window); a retried delivery is parsed and returned but its side
  effects (credit grant, `onEvent`) run at most once.
- **At-least-once credit granting tied to payment.** On `payment.succeeded`, the
  matched plan's `credits` are granted to the resolved account exactly once per
  event id (subject to the dedupe window). Granting requires a configured KV.
- **Credits-ledger atomicity.** `grant`/`consume` mutate the balance with the
  KV's atomic `incrBy`, so concurrent operations across instances stay
  consistent. `consume` refuses to overdraw unless `allowNegative` is set.
- **404 → null.** `getCustomer`/`getSubscription` return `null` for not-found
  rather than throwing; other non-OK responses throw `BillingError` with status.

## Non-guarantees

- **No provider-API drift protection.** Adapters target the providers' current
  REST APIs; a breaking provider change requires an adapter update.
- **Capability gaps are explicit, not emulated.** Where a provider lacks a
  portable capability (e.g. Paddle `reportUsage` / hosted portal), the adapter
  throws a clear `BillingError` or omits the optional method rather than faking it.
- **Dedupe/credit-grant require a global KV.** Without a KV, webhooks are still
  verified and parsed, but dedupe and auto-grant are skipped.
- **No reconciliation/polling.** State is event-driven; if a webhook is never
  delivered, Covara does not poll the provider to reconcile (handle critical
  flows in `onEvent` and consider a periodic reconcile task).
- **Account resolution is best-effort.** Auto-grant resolves the account from
  `metadata.accountId`/`userId` (set this at checkout) or the customer id; if
  neither is present, no credits are granted.
