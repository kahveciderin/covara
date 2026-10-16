---
id: billing
title: Billing
sidebar_label: Billing
description: One provider-agnostic billing layer over Stripe, Lemon Squeezy, Paddle, and Polar — plans, checkout, subscriptions, usage, a durable credits ledger, signature-verified idempotent webhooks, provider reconciliation, a router, and React hooks.
---

# Billing

A single, provider-agnostic billing layer over **Stripe**, **Lemon Squeezy**, **Paddle**, and **Polar.sh**. One `BillingAdapter` interface covers customers, checkout (subscriptions + one-time + usage), subscription management, usage reporting, a hosted portal, and signature-verified webhooks. On top of it, `createBilling()` adds plan definitions, a **credits ledger** (durable Drizzle-backed, or KV for back-compat), idempotent webhook handling with automatic credit granting, **reconciliation** against the provider for missed webhooks, a mountable **router**, and a typed **client** with React hooks.

All adapters are `fetch`-based with **no SDK dependencies** and run on Node and Cloudflare Workers. Import from `covara` or `covara/billing`.

## Choose an adapter

```typescript
import {
  createStripeAdapter, createLemonSqueezyAdapter, createPaddleAdapter, createPolarAdapter,
} from "covara/billing";

const adapter = createStripeAdapter({ apiKey: env.STRIPE_SECRET_KEY });
// createLemonSqueezyAdapter({ apiKey, storeId })
// createPaddleAdapter({ apiKey, sandbox: true })
// createPolarAdapter({ accessToken, server: "sandbox" })
```

What `items[].priceId` means per provider, and the verified webhook header:

| Provider | `priceId` is | Webhook header |
|----------|--------------|----------------|
| Stripe | Price id (`price_…`) | `stripe-signature` (HMAC-SHA256 of `t.payload`) |
| Lemon Squeezy | Variant id | `x-signature` (HMAC-SHA256 hex of body) |
| Paddle | Price id (`pri_…`) | `paddle-signature` (`ts:payload`) |
| Polar | Product/price id | Standard Webhooks (`webhook-signature`) |

## `createBilling`

```typescript
import { createBilling } from "covara/billing";

const billing = createBilling({
  adapter,
  webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  plans: [
    { key: "pro_monthly", priceId: "price_123", type: "subscription", interval: "month", credits: 10_000 },
    { key: "credits_pack", priceId: "price_456", type: "one_time", credits: 5_000 },
    { key: "metered_api", priceId: "price_789", type: "usage" },
  ],
});
```

`BillingPlan`: `{ key, priceId, name?, type?: "subscription"|"one_time"|"usage", credits?, interval?, metadata? }`. `credits` is granted to the account automatically when a payment for that plan succeeds (see [Webhooks](#webhooks)).

## Checkout

```typescript
const session = await billing.checkoutPlan("pro_monthly", {
  customerEmail: "user@example.com",
  successUrl: "https://app.acme.com/welcome",
  cancelUrl: "https://app.acme.com/pricing",
  metadata: { accountId: user.id }, // correlate the webhook back to your user
});
// redirect the browser to session.url
```

Or build directly with `billing.checkout({ mode, items, successUrl, ... })` — `mode` is `"subscription"` or `"payment"`; `checkoutPlan` infers it from the plan's `type`.

## Subscriptions & usage

```typescript
const sub = await billing.getSubscription("sub_123");
await billing.cancelSubscription("sub_123", { atPeriodEnd: true });
await billing.adapter.updateSubscription("sub_123", { priceId: "price_higher_tier" });
await billing.reportUsage({ subscriptionItemId: "si_123", quantity: 42, action: "increment" });
```

`BillingSubscription` is normalized: `{ id, customerId, status, priceId?, currentPeriodStart?, currentPeriodEnd?, cancelAtPeriodEnd?, metadata?, provider }`, with `status ∈ active|trialing|past_due|canceled|paused|incomplete|expired|unpaid`.

:::note Paddle
`reportUsage` and the hosted portal are managed differently on Paddle and throw a clear `BillingError` / are unavailable; usage is driven by Paddle prices.
:::

## Credits ledger

Credits are money-like, so the ledger should live in your database. `createDrizzleCreditsLedger` is the **recommended** ledger: an append-only `billing_credit_entries` journal plus a `billing_credit_balances` row per account, written together in one transaction (an atomic batch on D1). It runs on SQLite (libsql, better-sqlite3, D1) and PostgreSQL (postgres-js, PGlite, Neon).

```typescript
import { createBilling, createDrizzleCreditsLedger } from "covara/billing";
import { migrateInternal } from "covara";

await migrateInternal(db); // creates the billing_* internal tables

const billing = createBilling({
  adapter,
  credits: createDrizzleCreditsLedger({ db }),
});

await billing.credits.grant(accountId, 1000, { reason: "signup-bonus", idempotencyKey: `signup:${accountId}` });
const { ok, balance } = await billing.credits.consume(accountId, 50, {
  reason: "api-call",
  idempotencyKey: requestId,
});
await billing.credits.balance(accountId);
await billing.credits.history(accountId, 50); // newest first
const page = await billing.credits.historyPage(accountId, { limit: 100, cursor }); // full history
```

- **No overdraw.** `consume` returns `{ ok: false, balance }` instead of going below zero, even with many concurrent consumers. Pass `{ allowNegative: true }` to permit it.
- **Idempotency keys.** `grant`, `consume` and `set` accept an `idempotencyKey`, unique per account. Repeating a key with the same operation and amount applies once and returns the original result (`consume` adds `duplicate: true`). Reusing a key for a different operation or amount throws `CreditsIdempotencyConflictError`. A `consume` refused for insufficient balance does not use up its key.
- **Integer amounts.** Amounts must be non-negative safe integers. Store fractional units (cents, milli-credits) as integers.
- **Full history.** Every entry is kept. Page through it with `historyPage(account, { limit, cursor })` (the cursor is opaque).
- **Custom tables.** For your own table names or columns, pass `schema: defineInternalSchema({ creditEntries, creditBalances })`. See [Internal tables](../auth/internal-tables.md#billing_credit_entries).

:::caution The KV ledger is not durable
`createCreditsLedger(kv?)` is the default when you pass no `credits`, kept for back-compat. KV, especially Redis with an eviction policy, is **not a system of record**: balances can be evicted, history is capped at the 1000 most recent entries, and idempotency keys expire after 30 days (`idempotencyTtlMs`). It has the same API and idempotency keys, and its `consume` is atomic (debit, then refund if the balance went negative), but a refused consume can briefly report a lower balance while other consumers are in flight. Use it for development or non-critical quotas only.
:::

## Webhooks

```typescript
const event = await billing.handleWebhook(rawBody, headers);
```

`handleWebhook` verifies the provider signature (when `webhookSecret` is set), **de-duplicates** retried deliveries by event id (via [KV](./kv.md)), resolves the matched `planKey`/`creditsToGrant`, and on `payment.succeeded` **auto-grants** the plan's credits to the resolved account (from `metadata.accountId`/`userId`, else the customer id). It then calls your `onEvent` and finally records `subscription.*` state in the local [subscription store](#reconciliation). Normalized `BillingEvent.type`: `checkout.completed | subscription.created | subscription.updated | subscription.canceled | payment.succeeded | payment.failed | unknown`.

Failure handling:

- An event is marked as seen **only after every side effect succeeded**. If the credit grant, `onEvent`, or the state write throws, the claim is released and `webhookHandler()` answers **500**, so the provider retries and the retry is processed.
- While a delivery is being processed, a concurrent duplicate gets **409** (`handleWebhook` throws `BillingWebhookInFlightError`), so the provider retries later instead of hooks running twice. A crashed handler's claim lapses after `webhookLeaseMs` (default 5 minutes).
- A bad signature gets **400** (`BillingWebhookSignatureError`).
- Auto-grants pass `billing:<provider>:<event id>` as the ledger idempotency key, so a redelivery never double-grants, even after the 24h dedupe window or if the KV lost the dedupe record.

A retry after a partial failure can run `onEvent` again, so make `onEvent` idempotent (key side effects on `event.id`).

Disable auto-granting with `autoGrantCredits: false`, or customize account resolution with `resolveAccount: (event) => string`.

## Reconciliation

Webhooks can be missed or fail for good. Reconciliation fetches subscription state from the provider, compares it with the locally stored state, and sends any difference through **the same pipeline a webhook uses**. Your `onEvent` receives an ordinary `subscription.created | subscription.updated | subscription.canceled` event with `source: "reconcile"`.

```typescript
import { createBilling, createDrizzleCreditsLedger, createDrizzleSubscriptionStore } from "covara/billing";

const billing = createBilling({
  adapter,
  credits: createDrizzleCreditsLedger({ db }),
  subscriptions: createDrizzleSubscriptionStore({ db }), // default: KV-backed when a global KV exists
  onEvent: async (event) => { /* provision / deprovision */ },
});

const report = await billing.reconcile({ customerId: "cus_123" });
const all = await billing.reconcileAll({ concurrency: 2 });
// { dryRun, customersChecked, subscriptionsChecked, drift: [...], fixed, errors: [...], aborted? }
```

Each `drift` entry has a `kind`, the `changes` (field names), the `eventType` it was applied as, the `local`/`remote` snapshots, and an `outcome` (`applied`, `already_applied`, `skipped_concurrent_update`, `failed`, or `dry_run`):

| Drift | Applied as |
|---|---|
| `missing_locally`: the provider has it, it was never stored | `subscription.created` (or `.canceled` if it is already terminal) |
| `changed`: status, price, product, quantity, period, trial, cancel flag, or customer differ | `subscription.updated` (or `.canceled` when it became canceled/expired) |
| `missing_at_provider`: stored locally, the provider returns 404 | `subscription.canceled` with `status: "canceled"` |

Rules:

- **The provider wins.** When local state is "ahead" (for example, canceled locally but still active at the provider), the provider's state is applied.
- **Errors are never deletions.** A list or get call that still fails after retries is reported in `errors`, and that customer or subscription is left untouched. Only a 404 from `getSubscription` counts as deleted.
- **Rate limits.** 429 and 5xx responses are retried with exponential backoff (`retry: { attempts, baseDelayMs, maxDelayMs }`, default 4 attempts starting at 1s). `concurrency` defaults to 1.
- **Pagination.** All four adapters follow provider pagination in `listSubscriptions(customerId)` and implement `listAllSubscriptions({ cursor })`. `reconcileAll` walks that full listing and also re-checks every customer known locally. If the full listing fails, it falls back to listing customer by customer.
- **Idempotent.** A synthesized event gets a deterministic id from the local and remote state, so concurrent reconcile runs fire each hook once. If a drift's hook throws, the drift is reported as `failed` and its state is not written, so the next run retries it.
- **Webhooks mid-run.** If a webhook updates a subscription after reconcile read it, the drift is reported as `skipped_concurrent_update` and left for the next run. An older provider snapshot never overwrites newer webhook state.
- `dryRun: true` reports drift without firing hooks or writing state. Pass a `signal` to stop between customers.

### Scheduling reconciliation

```typescript
import { createBillingReconcileTask } from "covara/billing";

const reconcileTask = createBillingReconcileTask({ billing, cron: "*/15 * * * *" }); // or { interval: 900_000 }
registry.register(reconcileTask.task);
await reconcileTask.schedule(scheduler); // scheduler.scheduleRecurring(task, {}, recurring)
```

The task is named `covara:billing:reconcile` and runs with `maxConcurrency: 1` and no retries. It calls `reconcileAll` with the worker's abort signal and returns a JSON summary (`customersChecked`, `driftFound`, `fixed`, `errors`, …). See [Background tasks](./tasks.md).

## Server router

```typescript
import { createBillingRouter } from "covara/billing";
import { getUser } from "covara";

app.route("/api/billing", createBillingRouter(billing, {
  getAccount: (c) => getUser(c)?.id,
  getCustomerId: (c) => getUser(c)?.billingCustomerId,
  getCustomerEmail: (c) => getUser(c)?.email,
  authorizeReconcile: (c) => getUser(c)?.role === "admin", // optional: mounts POST /reconcile
}));
```

Endpoints (non-webhook routes require an authenticated user):

- `POST /checkout` → `{ id, url }`
- `GET /subscription` → `{ subscriptions }`
- `POST /portal` → `{ url }`
- `GET /credits` → `{ balance }`
- `POST /webhook` → signature-verified, idempotent (200 ok / 400 bad signature / 409 already in flight / 500 handler failed)
- `POST /reconcile` → `{ customerId?, dryRun? }` → reconcile report. Only mounted when `authorizeReconcile` is set; 403 when it denies the caller

## Client & React

```typescript
import { getOrCreateClient } from "covara/client";
import { useCredits, useSubscription, useCheckout } from "covara/client/react";

const client = getOrCreateClient({ baseUrl: location.origin, billing: { basePath: "/api/billing" } });
await client.billing.redirectToCheckout({ plan: "pro_monthly", successUrl: location.origin + "/welcome" });
```

```tsx
const { balance, refresh } = useCredits();
const { activeSubscription } = useSubscription();
const { redirectToCheckout, loading } = useCheckout();
```

See [Client billing hooks](../client/billing.md).

## End-to-end flow

1. Define `plans` (with `credits`) and `createBilling`.
2. Mount `createBillingRouter`; point the provider's webhook at `/api/billing/webhook`.
3. Client calls `redirectToCheckout({ plan })` → hosted checkout.
4. Provider fires `payment.succeeded` → router verifies + dedupes + grants `plan.credits` (idempotently, keyed on the event id).
5. App consumes credits via `billing.credits.consume(accountId, n, { idempotencyKey })`.
6. A scheduled `createBillingReconcileTask` repairs any subscription state a missed webhook left wrong.

Webhook de-duplication and the default KV ledger/subscription store require a configured global [KV](./kv.md); with `createDrizzleCreditsLedger` + `createDrizzleSubscriptionStore`, credits and subscription state live in your database. For side effects beyond credit granting (emails, provisioning), handle them in `onEvent` and offload to a [background task](./tasks.md).

## Related

- [Client billing hooks](../client/billing.md) · [KV store](./kv.md) · [Background tasks](./tasks.md) · [Internal tables](../auth/internal-tables.md)
- [Billing contract](../contracts/billing.md)
