import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createPaddleAdapter } from "@/billing/paddle";

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

const jsonBody = (body: string | undefined): any => (body ? JSON.parse(body) : {});

const adapter = createPaddleAdapter({ apiKey: "pdl_test_123" });
const sandboxAdapter = createPaddleAdapter({ apiKey: "pdl_sb", sandbox: true });

beforeEach(() => {
  calls.length = 0;
  nextResponses = [];
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockClear();
});

describe("Paddle adapter — customers", () => {
  it("creates a customer with JSON body and auth header", async () => {
    queue({ data: { id: "ctm_1", email: "a@b.c", name: "Ann", custom_data: { plan: "x" } } });
    const customer = await adapter.createCustomer({ email: "a@b.c", name: "Ann", metadata: { plan: "x" } });

    const call = calls[0];
    expect(call.url).toBe("https://api.paddle.com/customers");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer pdl_test_123");
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = jsonBody(call.body);
    expect(body.email).toBe("a@b.c");
    expect(body.name).toBe("Ann");
    expect(body.custom_data).toEqual({ plan: "x" });

    expect(customer).toEqual({
      id: "ctm_1",
      email: "a@b.c",
      name: "Ann",
      metadata: { plan: "x" },
      provider: "paddle",
    });
  });

  it("uses the sandbox base url when configured", async () => {
    queue({ data: { id: "ctm_1" } });
    await sandboxAdapter.getCustomer("ctm_1");
    expect(calls[0].url).toBe("https://sandbox-api.paddle.com/customers/ctm_1");
  });

  it("returns null on 404 for getCustomer", async () => {
    queue({ error: { detail: "no" } }, 404);
    expect(await adapter.getCustomer("missing")).toBeNull();
  });
});

describe("Paddle adapter — checkout", () => {
  it("creates a transaction and returns its checkout url", async () => {
    queue({
      data: { id: "txn_1", checkout: { url: "https://pay.paddle.com/txn_1" } },
    });
    const session = await adapter.createCheckout({
      mode: "subscription",
      items: [{ priceId: "pri_a", quantity: 2 }],
      customerId: "ctm_1",
      successUrl: "https://app/ok",
      metadata: { accountId: "acct-1" },
    });

    const call = calls[0];
    expect(call.url).toBe("https://api.paddle.com/transactions");
    const body = jsonBody(call.body);
    expect(body.items).toEqual([{ price_id: "pri_a", quantity: 2 }]);
    expect(body.customer_id).toBe("ctm_1");
    expect(body.custom_data).toEqual({ accountId: "acct-1" });

    expect(session).toEqual({ id: "txn_1", url: "https://pay.paddle.com/txn_1", provider: "paddle" });
  });

  it("passes customer email when no customer id is given", async () => {
    queue({ data: { id: "txn_2", checkout: { url: "https://x" } } });
    await adapter.createCheckout({
      mode: "payment",
      items: [{ priceId: "pri_a" }],
      customerEmail: "user@x.com",
      successUrl: "https://app/ok",
    });
    const body = jsonBody(calls[0].body);
    expect(body.items[0].quantity).toBe(1);
    expect(body.customer).toEqual({ email: "user@x.com" });
    expect(body.customer_id).toBeUndefined();
  });
});

describe("Paddle adapter — subscriptions", () => {
  const rawSub = {
    id: "sub_1",
    customer_id: "ctm_1",
    status: "active",
    items: [{ quantity: 3, price: { id: "pri_a", product_id: "pro_a" } }],
    current_billing_period: { starts_at: "2024-01-01T00:00:00Z", ends_at: "2024-02-01T00:00:00Z" },
    scheduled_change: null,
    trial_dates: null,
    custom_data: { accountId: "acct-9" },
  };

  it("gets and maps a subscription", async () => {
    queue({ data: rawSub });
    const sub = await adapter.getSubscription("sub_1");
    expect(calls[0].url).toBe("https://api.paddle.com/subscriptions/sub_1");
    expect(sub).toMatchObject({
      id: "sub_1",
      customerId: "ctm_1",
      status: "active",
      priceId: "pri_a",
      productId: "pro_a",
      quantity: 3,
      cancelAtPeriodEnd: false,
      metadata: { accountId: "acct-9" },
      provider: "paddle",
    });
    expect(sub?.currentPeriodStart).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(sub?.currentPeriodEnd).toEqual(new Date("2024-02-01T00:00:00Z"));
  });

  it("derives cancelAtPeriodEnd from a scheduled cancel change", async () => {
    queue({ data: { ...rawSub, scheduled_change: { action: "cancel", effective_at: "2024-02-01T00:00:00Z" } } });
    expect((await adapter.getSubscription("sub_1"))?.cancelAtPeriodEnd).toBe(true);
  });

  it("lists subscriptions for a customer", async () => {
    queue({ data: [rawSub, { ...rawSub, id: "sub_2" }] });
    const subs = await adapter.listSubscriptions("ctm_1");
    expect(calls[0].url).toContain("/subscriptions?customer_id=ctm_1");
    expect(subs).toHaveLength(2);
    expect(subs[1].id).toBe("sub_2");
  });

  it("cancels immediately by default", async () => {
    queue({ data: { ...rawSub, status: "canceled" } });
    const sub = await adapter.cancelSubscription("sub_1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.paddle.com/subscriptions/sub_1/cancel");
    expect(jsonBody(calls[0].body).effective_from).toBe("immediately");
    expect(sub.status).toBe("canceled");
  });

  it("cancels at period end with next_billing_period", async () => {
    queue({ data: { ...rawSub, scheduled_change: { action: "cancel" } } });
    const sub = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });
    expect(jsonBody(calls[0].body).effective_from).toBe("next_billing_period");
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("updates the price via PATCH", async () => {
    queue({ data: rawSub });
    await adapter.updateSubscription("sub_1", { priceId: "pri_b", quantity: 5 });
    expect(calls[0].method).toBe("PATCH");
    const body = jsonBody(calls[0].body);
    expect(body.items).toEqual([{ price_id: "pri_b", quantity: 5 }]);
  });

  it("schedules a cancel via updateSubscription cancelAtPeriodEnd", async () => {
    queue({ data: rawSub });
    await adapter.updateSubscription("sub_1", { cancelAtPeriodEnd: true });
    const body = jsonBody(calls[0].body);
    expect(body.scheduled_change.action).toBe("cancel");
  });
});

describe("Paddle adapter — usage", () => {
  it("throws a clear BillingError for reportUsage", async () => {
    await expect(
      adapter.reportUsage({ subscriptionItemId: "x", quantity: 1 })
    ).rejects.toThrow("Paddle usage reporting is managed via prices");
  });
});

describe("Paddle adapter — errors", () => {
  it("throws BillingError on non-ok non-404 responses", async () => {
    queue({ error: { detail: "bad price" } }, 400);
    await expect(
      adapter.createCheckout({ mode: "subscription", items: [{ priceId: "pri_x" }], successUrl: "https://app/ok" })
    ).rejects.toThrow("bad price");
  });
});

const SECRET = "pdl_whsec_test";

const sign = (payload: string, ts: number, secret = SECRET): string => {
  const h1 = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
};

describe("Paddle adapter — verifyWebhook", () => {
  it("accepts a valid signature", () => {
    const payload = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created" });
    const ts = Math.floor(Date.now() / 1000);
    expect(adapter.verifyWebhook(payload, { "paddle-signature": sign(payload, ts) }, SECRET)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ event_id: "evt_1" });
    const ts = Math.floor(Date.now() / 1000);
    expect(adapter.verifyWebhook("{}", { "paddle-signature": sign(payload, ts) }, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000);
    expect(adapter.verifyWebhook(payload, { "paddle-signature": sign(payload, ts, "other") }, SECRET)).toBe(false);
  });

  it("rejects an old signature (>5min skew)", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000) - 600;
    expect(adapter.verifyWebhook(payload, { "paddle-signature": sign(payload, ts) }, SECRET)).toBe(false);
  });

  it("rejects when header is missing or malformed", () => {
    expect(adapter.verifyWebhook("{}", {}, SECRET)).toBe(false);
    expect(adapter.verifyWebhook("{}", { "paddle-signature": "garbage" }, SECRET)).toBe(false);
  });
});

describe("Paddle adapter — parseWebhookEvent", () => {
  it("maps subscription.updated with priceId and custom metadata", () => {
    const payload = JSON.stringify({
      event_id: "evt_sub",
      event_type: "subscription.updated",
      data: {
        id: "sub_1",
        customer_id: "ctm_1",
        status: "active",
        custom_data: { accountId: "acct-3" },
        items: [{ price: { id: "pri_pro" } }],
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.id).toBe("evt_sub");
    expect(event.type).toBe("subscription.updated");
    expect(event.customerId).toBe("ctm_1");
    expect(event.subscription?.priceId).toBe("pri_pro");
    expect(event.subscription?.metadata).toEqual({ accountId: "acct-3" });
    expect(event.metadata).toEqual({ accountId: "acct-3" });
  });

  it("maps subscription.canceled", () => {
    const payload = JSON.stringify({
      event_id: "evt_c",
      event_type: "subscription.canceled",
      data: { id: "sub_1", customer_id: "ctm_1", status: "canceled" },
    });
    expect(adapter.parseWebhookEvent(payload, {})!.type).toBe("subscription.canceled");
  });

  it("maps transaction.completed to payment.succeeded with amount/currency/priceId", () => {
    const payload = JSON.stringify({
      event_id: "evt_txn",
      event_type: "transaction.completed",
      data: {
        id: "txn_1",
        customer_id: "ctm_1",
        currency_code: "USD",
        custom_data: { userId: "u-1" },
        details: { totals: { total: "1500" } },
        items: [{ price: { id: "pri_pro" } }],
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("payment.succeeded");
    expect(event.customerId).toBe("ctm_1");
    expect(event.currency).toBe("USD");
    expect(event.amount).toBe(1500);
    expect(event.subscription?.priceId).toBe("pri_pro");
    expect(event.metadata).toEqual({ userId: "u-1" });
  });

  it("maps transaction.payment_failed to payment.failed", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ event_id: "e2", event_type: "transaction.payment_failed", data: { customer_id: "c" } }),
      {}
    )!;
    expect(event.type).toBe("payment.failed");
  });

  it("maps unknown event types to unknown", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ event_id: "e3", event_type: "address.created", data: {} }),
      {}
    )!;
    expect(event.type).toBe("unknown");
  });

  it("returns null on invalid JSON or missing event_type", () => {
    expect(adapter.parseWebhookEvent("not json", {})).toBeNull();
    expect(adapter.parseWebhookEvent(JSON.stringify({ data: {} }), {})).toBeNull();
  });
});
