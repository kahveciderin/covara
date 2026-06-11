import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createStripeAdapter } from "@/billing/stripe";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const calls: FetchCall[] = [];
let nextResponses: Array<{ status: number; body: unknown }> = [];

const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
  calls.push({
    url,
    method: (init.method ?? "GET").toUpperCase(),
    headers: (init.headers as Record<string, string>) ?? {},
    body: init.body as string | undefined,
  });
  const next = nextResponses.shift() ?? { status: 200, body: {} };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
  } as Response;
});

const queue = (body: unknown, status = 200): void => {
  nextResponses.push({ status, body });
};

const parseBody = (body: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!body) return out;
  for (const pair of body.split("&")) {
    const [k, v] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
};

const adapter = createStripeAdapter({ apiKey: "sk_test_123" });

beforeEach(() => {
  calls.length = 0;
  nextResponses = [];
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockClear();
});

describe("Stripe adapter — customers", () => {
  it("creates a customer with form-encoded body and auth header", async () => {
    queue({ id: "cus_1", email: "a@b.c", name: "Ann", metadata: { plan: "x" } });
    const customer = await adapter.createCustomer({
      email: "a@b.c",
      name: "Ann",
      metadata: { plan: "x" },
    });

    const call = calls[0];
    expect(call.url).toBe("https://api.stripe.com/v1/customers");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer sk_test_123");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = parseBody(call.body);
    expect(form.email).toBe("a@b.c");
    expect(form.name).toBe("Ann");
    expect(form["metadata[plan]"]).toBe("x");

    expect(customer).toEqual({
      id: "cus_1",
      email: "a@b.c",
      name: "Ann",
      metadata: { plan: "x" },
      provider: "stripe",
    });
  });

  it("returns null on 404 for getCustomer", async () => {
    queue({ error: { message: "no" } }, 404);
    expect(await adapter.getCustomer("cus_missing")).toBeNull();
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers/cus_missing");
    expect(calls[0].method).toBe("GET");
  });
});

describe("Stripe adapter — checkout", () => {
  it("form-encodes nested line_items and trial period", async () => {
    queue({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    const session = await adapter.createCheckout({
      mode: "subscription",
      items: [
        { priceId: "price_a", quantity: 2 },
        { priceId: "price_b" },
      ],
      customerEmail: "user@x.com",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      metadata: { accountId: "acct-1" },
      trialDays: 14,
    });

    const form = parseBody(calls[0].body);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(form.mode).toBe("subscription");
    expect(form["line_items[0][price]"]).toBe("price_a");
    expect(form["line_items[0][quantity]"]).toBe("2");
    expect(form["line_items[1][price]"]).toBe("price_b");
    expect(form["line_items[1][quantity]"]).toBe("1");
    expect(form.success_url).toBe("https://app/ok");
    expect(form.cancel_url).toBe("https://app/no");
    expect(form.customer_email).toBe("user@x.com");
    expect(form["metadata[accountId]"]).toBe("acct-1");
    expect(form["subscription_data[trial_period_days]"]).toBe("14");

    expect(session).toEqual({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/cs_1",
      provider: "stripe",
    });
  });

  it("uses customer over customer_email when provided", async () => {
    queue({ id: "cs_2", url: "https://x" });
    await adapter.createCheckout({
      mode: "payment",
      items: [{ priceId: "price_a" }],
      customerId: "cus_1",
      customerEmail: "ignored@x.com",
      successUrl: "https://app/ok",
    });
    const form = parseBody(calls[0].body);
    expect(form.customer).toBe("cus_1");
    expect(form.customer_email).toBeUndefined();
    expect(form["subscription_data[trial_period_days]"]).toBeUndefined();
  });
});

describe("Stripe adapter — subscriptions", () => {
  const rawSub = {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    metadata: { accountId: "acct-9" },
    items: { data: [{ id: "si_1", quantity: 3, price: { id: "price_a", product: "prod_a" } }] },
  };

  it("gets and maps a subscription", async () => {
    queue(rawSub);
    const sub = await adapter.getSubscription("sub_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(sub).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceId: "price_a",
      productId: "prod_a",
      quantity: 3,
      cancelAtPeriodEnd: false,
      metadata: { accountId: "acct-9" },
      provider: "stripe",
    });
    expect(sub?.currentPeriodStart).toEqual(new Date(1700000000 * 1000));
    expect(sub?.currentPeriodEnd).toEqual(new Date(1702592000 * 1000));
  });

  it("maps incomplete_expired to expired", async () => {
    queue({ ...rawSub, status: "incomplete_expired" });
    const sub = await adapter.getSubscription("sub_1");
    expect(sub?.status).toBe("expired");
  });

  it("lists subscriptions for a customer", async () => {
    queue({ data: [rawSub, { ...rawSub, id: "sub_2" }] });
    const subs = await adapter.listSubscriptions("cus_1");
    expect(calls[0].url).toContain("/subscriptions?customer=cus_1");
    expect(subs).toHaveLength(2);
    expect(subs[1].id).toBe("sub_2");
  });

  it("cancels immediately with DELETE", async () => {
    queue({ ...rawSub, status: "canceled" });
    const sub = await adapter.cancelSubscription("sub_1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(sub.status).toBe("canceled");
  });

  it("cancels at period end with POST", async () => {
    queue({ ...rawSub, cancel_at_period_end: true });
    const sub = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });
    expect(calls[0].method).toBe("POST");
    const form = parseBody(calls[0].body);
    expect(form.cancel_at_period_end).toBe("true");
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("updates price, quantity, and cancel flag", async () => {
    queue(rawSub);
    await adapter.updateSubscription("sub_1", {
      priceId: "price_b",
      quantity: 5,
      cancelAtPeriodEnd: false,
    });
    expect(calls[0].method).toBe("POST");
    const form = parseBody(calls[0].body);
    expect(form["items[0][price]"]).toBe("price_b");
    expect(form["items[0][quantity]"]).toBe("5");
    expect(form.cancel_at_period_end).toBe("false");
  });
});

describe("Stripe adapter — usage and portal", () => {
  it("reports usage to the usage_records endpoint", async () => {
    queue({ id: "mbur_1" });
    const ts = new Date(1700000000 * 1000);
    await adapter.reportUsage({
      subscriptionItemId: "si_1",
      quantity: 10,
      action: "set",
      timestamp: ts,
    });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscription_items/si_1/usage_records");
    expect(calls[0].method).toBe("POST");
    const form = parseBody(calls[0].body);
    expect(form.quantity).toBe("10");
    expect(form.action).toBe("set");
    expect(form.timestamp).toBe("1700000000");
  });

  it("defaults action to increment", async () => {
    queue({ id: "mbur_2" });
    await adapter.reportUsage({ subscriptionItemId: "si_1", quantity: 1 });
    expect(parseBody(calls[0].body).action).toBe("increment");
  });

  it("creates a billing portal session", async () => {
    queue({ url: "https://billing.stripe.com/p/session_1" });
    const portal = await adapter.createPortalSession!("cus_1", "https://app/back");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const form = parseBody(calls[0].body);
    expect(form.customer).toBe("cus_1");
    expect(form.return_url).toBe("https://app/back");
    expect(portal).toEqual({ url: "https://billing.stripe.com/p/session_1" });
  });
});

describe("Stripe adapter — errors", () => {
  it("throws BillingError on non-ok non-404 responses", async () => {
    queue({ error: { message: "bad price" } }, 400);
    await expect(
      adapter.createCheckout({
        mode: "subscription",
        items: [{ priceId: "price_x" }],
        successUrl: "https://app/ok",
      })
    ).rejects.toThrow("bad price");
  });
});

const SECRET = "whsec_test";

const sign = (payload: string, timestamp: number, secret = SECRET): string => {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
};

describe("Stripe adapter — verifyWebhook", () => {
  it("accepts a valid signature", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const ts = Math.floor(Date.now() / 1000);
    const ok = adapter.verifyWebhook(payload, { "stripe-signature": sign(payload, ts) }, SECRET);
    expect(ok).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(payload, ts);
    const ok = adapter.verifyWebhook("{\"id\":\"evt_2\"}", { "stripe-signature": header }, SECRET);
    expect(ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(payload, ts, "other_secret");
    expect(adapter.verifyWebhook(payload, { "stripe-signature": header }, SECRET)).toBe(false);
  });

  it("rejects an old signature (>5min skew)", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000) - 600;
    const header = sign(payload, ts);
    expect(adapter.verifyWebhook(payload, { "stripe-signature": header }, SECRET)).toBe(false);
  });

  it("rejects when header is missing", () => {
    expect(adapter.verifyWebhook("{}", {}, SECRET)).toBe(false);
  });
});

describe("Stripe adapter — parseWebhookEvent", () => {
  it("maps checkout.session.completed and extracts metadata/customer", () => {
    const payload = JSON.stringify({
      id: "evt_co",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          customer: "cus_1",
          amount_total: 2000,
          currency: "usd",
          metadata: { accountId: "acct-7" },
        },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.id).toBe("evt_co");
    expect(event.type).toBe("checkout.completed");
    expect(event.customerId).toBe("cus_1");
    expect(event.amount).toBe(2000);
    expect(event.currency).toBe("usd");
    expect(event.metadata).toEqual({ accountId: "acct-7" });
  });

  it("maps subscription events with priceId and metadata", () => {
    const payload = JSON.stringify({
      id: "evt_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          metadata: { accountId: "acct-3" },
          items: { data: [{ id: "si_1", price: { id: "price_pro" } }] },
        },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("subscription.updated");
    expect(event.customerId).toBe("cus_1");
    expect(event.subscription?.priceId).toBe("price_pro");
    expect(event.subscription?.metadata).toEqual({ accountId: "acct-3" });
    expect(event.metadata).toEqual({ accountId: "acct-3" });
  });

  it("maps subscription.deleted to subscription.canceled", () => {
    const payload = JSON.stringify({
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } },
    });
    expect(adapter.parseWebhookEvent(payload, {})!.type).toBe("subscription.canceled");
  });

  it("maps invoice.payment_succeeded with amount, currency, and priceId", () => {
    const payload = JSON.stringify({
      id: "evt_inv",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_1",
          customer: "cus_1",
          amount_paid: 1500,
          currency: "eur",
          subscription: "sub_1",
          metadata: { userId: "u-1" },
          lines: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("payment.succeeded");
    expect(event.amount).toBe(1500);
    expect(event.currency).toBe("eur");
    expect(event.customerId).toBe("cus_1");
    expect(event.subscription?.priceId).toBe("price_pro");
    expect(event.subscription?.id).toBe("sub_1");
    expect(event.metadata).toEqual({ userId: "u-1" });
  });

  it("maps invoice.paid and invoice.payment_failed", () => {
    const paid = adapter.parseWebhookEvent(
      JSON.stringify({ id: "e1", type: "invoice.paid", data: { object: { customer: "c" } } }),
      {}
    )!;
    expect(paid.type).toBe("payment.succeeded");
    const failed = adapter.parseWebhookEvent(
      JSON.stringify({ id: "e2", type: "invoice.payment_failed", data: { object: { customer: "c" } } }),
      {}
    )!;
    expect(failed.type).toBe("payment.failed");
  });

  it("maps unknown event types to unknown", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ id: "e3", type: "customer.created", data: { object: {} } }),
      {}
    )!;
    expect(event.type).toBe("unknown");
  });

  it("returns null on invalid JSON", () => {
    expect(adapter.parseWebhookEvent("not json", {})).toBeNull();
  });
});
