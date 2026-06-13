---
id: billing
title: Billing (client)
sidebar_label: Billing
description: The client.billing API and the useCredits, useSubscription, and useCheckout React hooks for checkout redirects, credit balances, and subscription state.
---

# Billing (client)

Configure `billing` on the client to talk to a mounted [billing router](../platform/billing.md), then use `client.billing.*` or the React hooks.

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({
  baseUrl: location.origin,
  billing: { basePath: "/api/billing" },
});

await client.billing.redirectToCheckout({
  plan: "pro_monthly",
  successUrl: location.origin + "/welcome",
});
```

## React hooks

```tsx
import { useCredits, useSubscription, useCheckout } from "covara/client/react";

function Billing() {
  const { balance, refresh } = useCredits();
  const { activeSubscription } = useSubscription();
  const { redirectToCheckout, loading } = useCheckout();

  return (
    <div>
      <p>Credits: {balance}</p>
      <p>Plan: {activeSubscription?.status ?? "none"}</p>
      <button disabled={loading} onClick={() => redirectToCheckout({ plan: "pro_monthly", successUrl: location.origin + "/welcome" })}>
        Upgrade
      </button>
    </div>
  );
}
```

- `useCredits` — `{ balance, refresh }` from the credits ledger.
- `useSubscription` — `{ activeSubscription }` (normalized across providers).
- `useCheckout` — `{ redirectToCheckout, loading }`.

These map to the [billing router](../platform/billing.md#server-router) endpoints (`/credits`, `/subscription`, `/checkout`, `/portal`). The router resolves the current user as the credits account, so the hooks operate on the signed-in user.

## Related

- [Billing (server)](../platform/billing.md) · [Client auth](./auth.md)
