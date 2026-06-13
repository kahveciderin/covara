---
id: billing
title: Billing
sidebar_label: Billing
description: One provider-agnostic billing layer over Stripe, Lemon Squeezy, Paddle, and Polar — plans, checkout, subscriptions, usage, a KV-backed credits ledger, signature-verified idempotent webhooks, a router, and React hooks.
---

# Billing

A single, provider-agnostic billing layer over **Stripe**, **Lemon Squeezy**, **Paddle**, and **Polar.sh**. One `BillingAdapter` interface covers customers, checkout (subscriptions + one-time + usage), subscription management, usage reporting, a hosted portal, and signature-verified webhooks. On top of it, `createBilling()` adds plan definitions, a KV-backed **credits ledger**, idempotent webhook handling with automatic credit granting, a mountable **router**, and a typed **client** with React hooks.

All adapters are `fetch`-based with **no SDK dependencies** and run on Node and Cloudflare Workers. Import from `covara` or `covara/billing`.

## Choose an adapter

```typescript
import {
  createStripeAdapter, createLemonSqueezyAdapter, createPaddleAdapter, createPolarAdapter,
} from "covara/billing";

const adapter = createStripeAdapter({ apiKey: process.env.STRIPE_SECRET_KEY! });
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
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
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

KV-backed and atomic (uses the KV's `incrBy`). Available as `billing.credits` or standalone via `createCreditsLedger()`.

```typescript
await billing.credits.grant(accountId, 1000, { reason: "signup-bonus" });
const { ok, balance } = await billing.credits.consume(accountId, 50, { reason: "api-call" });
await billing.credits.balance(accountId);
await billing.credits.history(accountId, 50);
```

`consume` refuses to overdraw unless `{ allowNegative: true }`.

## Webhooks

```typescript
const event = await billing.handleWebhook(rawBody, headers);
```

`handleWebhook` verifies the provider signature (when `webhookSecret` is set), **de-duplicates** retried deliveries by event id (via [KV](./kv.md)), resolves the matched `planKey`/`creditsToGrant`, and — on `payment.succeeded` — **auto-grants** the plan's credits to the resolved account (from `metadata.accountId`/`userId`, else the customer id), then calls your `onEvent`. Normalized `BillingEvent.type`: `checkout.completed | subscription.created | subscription.updated | subscription.canceled | payment.succeeded | payment.failed | unknown`.

Disable auto-granting with `autoGrantCredits: false`, or customize account resolution with `resolveAccount: (event) => string`.

## Server router

```typescript
import { createBillingRouter } from "covara/billing";

app.route("/api/billing", createBillingRouter(billing, {
  getAccount: (c) => c.get("user")?.id,
  getCustomerId: (c) => c.get("user")?.billingCustomerId,
  getCustomerEmail: (c) => c.get("user")?.email,
}));
```

Endpoints (non-webhook routes require an authenticated user):

- `POST /checkout` → `{ id, url }`
- `GET /subscription` → `{ subscriptions }`
- `POST /portal` → `{ url }`
- `GET /credits` → `{ balance }`
- `POST /webhook` → signature-verified, idempotent

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
4. Provider fires `payment.succeeded` → router verifies + dedupes + grants `plan.credits`.
5. App consumes credits via `billing.credits.consume(accountId, n)`.

Webhook idempotency and credit granting require a configured global [KV](./kv.md). For side effects beyond credit granting (emails, provisioning), handle them in `onEvent` and offload to a [background task](./tasks.md).

## Related

- [Client billing hooks](../client/billing.md) · [KV store](./kv.md) · [Background tasks](./tasks.md)
- [Billing contract](../contracts/billing.md)
