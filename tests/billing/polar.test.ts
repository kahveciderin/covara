import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createPolarAdapter } from "@/billing/polar";

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

const jsonBody = (body: string | undefined): Record<string, unknown> =>
  body ? (JSON.parse(body) as Record<string, unknown>) : {};

const adapter = createPolarAdapter({ accessToken: "polar_at_123" });

beforeEach(() => {
  calls.length = 0;
  nextResponses = [];
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockClear();
});

describe("Polar adapter — server selection", () => {
  it("targets the sandbox base url when configured", async () => {
    const sandbox = createPolarAdapter({ accessToken: "x", server: "sandbox" });
    queue({ id: "cus_1", email: "a@b.c" });
    await sandbox.createCustomer({ email: "a@b.c" });
    expect(calls[0].url).toBe("https://sandbox-api.polar.sh/v1/customers");
  });
});

describe("Polar adapter — customers", () => {
  it("creates a customer with JSON body and bearer auth", async () => {
    queue({ id: "cus_1", email: "a@b.c", name: "Ann", metadata: { plan: "x" } });
    const customer = await adapter.createCustomer({
      email: "a@b.c",
      name: "Ann",
      metadata: { plan: "x" },
    });

    const call = calls[0];
    expect(call.url).toBe("https://api.polar.sh/v1/customers");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer polar_at_123");
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = jsonBody(call.body);
    expect(body.email).toBe("a@b.c");
    expect(body.name).toBe("Ann");
    expect(body.metadata).toEqual({ plan: "x" });

    expect(customer).toEqual({
      id: "cus_1",
      email: "a@b.c",
      name: "Ann",
      metadata: { plan: "x" },
      provider: "polar",
    });
  });

  it("returns null on 404 for getCustomer", async () => {
    queue({ detail: "not found" }, 404);
    expect(await adapter.getCustomer("cus_missing")).toBeNull();
    expect(calls[0].url).toBe("https://api.polar.sh/v1/customers/cus_missing");
    expect(calls[0].method).toBe("GET");
  });
});

describe("Polar adapter — checkout", () => {
  it("posts products, success_url, email, and metadata", async () => {
    queue({ id: "co_1", url: "https://buy.polar.sh/co_1" });
    const session = await adapter.createCheckout({
      mode: "subscription",
      items: [{ priceId: "prod_a" }, { priceId: "prod_b" }],
      customerEmail: "user@x.com",
      successUrl: "https://app/ok",
      metadata: { accountId: "acct-1" },
    });

    const call = calls[0];
    expect(call.url).toBe("https://api.polar.sh/v1/checkouts/");
    expect(call.method).toBe("POST");
    const body = jsonBody(call.body);
    expect(body.products).toEqual(["prod_a", "prod_b"]);
    expect(body.success_url).toBe("https://app/ok");
    expect(body.customer_email).toBe("user@x.com");
    expect(body.metadata).toEqual({ accountId: "acct-1" });

    expect(session).toEqual({
      id: "co_1",
      url: "https://buy.polar.sh/co_1",
      provider: "polar",
    });
  });

  it("sends customer_id when provided", async () => {
    queue({ id: "co_2", url: "https://x" });
    await adapter.createCheckout({
      mode: "subscription",
      items: [{ priceId: "prod_a" }],
      customerId: "cus_1",
      successUrl: "https://app/ok",
    });
    const body = jsonBody(calls[0].body);
    expect(body.customer_id).toBe("cus_1");
  });
});

describe("Polar adapter — subscriptions", () => {
  const rawSub = {
    id: "sub_1",
    customer_id: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_start: "2024-01-01T00:00:00Z",
    current_period_end: "2024-02-01T00:00:00Z",
    product_id: "prod_a",
    price: { id: "price_a", product_id: "prod_a" },
    quantity: 3,
    metadata: { accountId: "acct-9" },
  };

  it("gets and maps a subscription", async () => {
    queue(rawSub);
    const sub = await adapter.getSubscription("sub_1");
    expect(calls[0].url).toBe("https://api.polar.sh/v1/subscriptions/sub_1");
    expect(sub).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceId: "price_a",
      productId: "prod_a",
      quantity: 3,
      cancelAtPeriodEnd: false,
      metadata: { accountId: "acct-9" },
      provider: "polar",
    });
    expect(sub?.currentPeriodStart).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(sub?.currentPeriodEnd).toEqual(new Date("2024-02-01T00:00:00Z"));
  });

  it("falls back to product_id for priceId when no price object", async () => {
    queue({ id: "sub_2", customer_id: "cus_1", status: "active", product_id: "prod_z" });
    const sub = await adapter.getSubscription("sub_2");
    expect(sub?.priceId).toBe("prod_z");
  });

  it("maps unknown status to incomplete", async () => {
    queue({ ...rawSub, status: "weird" });
    const sub = await adapter.getSubscription("sub_1");
    expect(sub?.status).toBe("incomplete");
  });

  it("lists subscriptions for a customer", async () => {
    queue({ items: [rawSub, { ...rawSub, id: "sub_2" }] });
    const subs = await adapter.listSubscriptions("cus_1");
    expect(calls[0].url).toContain("/v1/subscriptions/?customer_id=cus_1");
    expect(subs).toHaveLength(2);
    expect(subs[1].id).toBe("sub_2");
  });

  it("cancels immediately with DELETE", async () => {
    queue({ ...rawSub, status: "canceled" });
    const sub = await adapter.cancelSubscription("sub_1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.polar.sh/v1/subscriptions/sub_1");
    expect(sub.status).toBe("canceled");
  });

  it("cancels at period end with PATCH", async () => {
    queue({ ...rawSub, cancel_at_period_end: true });
    const sub = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });
    expect(calls[0].method).toBe("PATCH");
    const body = jsonBody(calls[0].body);
    expect(body.cancel_at_period_end).toBe(true);
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("updates product and cancel flag", async () => {
    queue(rawSub);
    await adapter.updateSubscription("sub_1", {
      priceId: "prod_b",
      cancelAtPeriodEnd: false,
    });
    expect(calls[0].method).toBe("PATCH");
    const body = jsonBody(calls[0].body);
    expect(body.product_id).toBe("prod_b");
    expect(body.cancel_at_period_end).toBe(false);
  });
});

describe("Polar adapter — usage and portal", () => {
  it("reports usage to the events ingest endpoint", async () => {
    queue({ inserted: 1 });
    const ts = new Date("2024-01-01T00:00:00Z");
    await adapter.reportUsage({
      subscriptionItemId: "api_calls",
      quantity: 10,
      timestamp: ts,
    });
    expect(calls[0].url).toBe("https://api.polar.sh/v1/events/ingest");
    expect(calls[0].method).toBe("POST");
    const body = jsonBody(calls[0].body) as { events: Array<Record<string, unknown>> };
    expect(body.events[0].name).toBe("api_calls");
    expect(body.events[0].metadata).toEqual({ units: 10 });
    expect(body.events[0].timestamp).toBe("2024-01-01T00:00:00.000Z");
  });

  it("creates a customer portal session", async () => {
    queue({ customer_portal_url: "https://polar.sh/portal/s1" });
    const portal = await adapter.createPortalSession!("cus_1", "https://app/back");
    expect(calls[0].url).toBe("https://api.polar.sh/v1/customer-sessions/");
    const body = jsonBody(calls[0].body);
    expect(body.customer_id).toBe("cus_1");
    expect(portal).toEqual({ url: "https://polar.sh/portal/s1" });
  });
});

describe("Polar adapter — errors", () => {
  it("throws BillingError on non-ok non-404 responses", async () => {
    queue({ detail: "bad product" }, 400);
    await expect(
      adapter.createCheckout({
        mode: "subscription",
        items: [{ priceId: "prod_x" }],
        successUrl: "https://app/ok",
      })
    ).rejects.toThrow("bad product");
  });
});

const SECRET = "whsec_" + Buffer.from("mysigningkey").toString("base64");

const signStandard = (
  id: string,
  timestamp: number,
  payload: string,
  secret = SECRET
): string => {
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret);
  const sig = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${sig}`;
};

const webhookHeaders = (
  id: string,
  ts: number,
  payload: string,
  secret = SECRET
): Record<string, string> => ({
  "webhook-id": id,
  "webhook-timestamp": String(ts),
  "webhook-signature": signStandard(id, ts, payload, secret),
});

describe("Polar adapter — verifyWebhook", () => {
  it("accepts a valid Standard Webhooks signature", () => {
    const payload = JSON.stringify({ type: "order.paid", data: { id: "ord_1" } });
    const ts = Math.floor(Date.now() / 1000);
    const ok = adapter.verifyWebhook(payload, webhookHeaders("msg_1", ts, payload), SECRET);
    expect(ok).toBe(true);
  });

  it("accepts a space-delimited multi-signature header", () => {
    const payload = JSON.stringify({ type: "order.paid", data: { id: "ord_1" } });
    const ts = Math.floor(Date.now() / 1000);
    const headers = webhookHeaders("msg_1", ts, payload);
    headers["webhook-signature"] = `v1,bogus ${headers["webhook-signature"]}`;
    expect(adapter.verifyWebhook(payload, headers, SECRET)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ type: "order.paid", data: { id: "ord_1" } });
    const ts = Math.floor(Date.now() / 1000);
    const headers = webhookHeaders("msg_1", ts, payload);
    expect(adapter.verifyWebhook('{"type":"order.created"}', headers, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const headers = webhookHeaders("msg_1", ts, payload, "whsec_" + Buffer.from("other").toString("base64"));
    expect(adapter.verifyWebhook(payload, headers, SECRET)).toBe(false);
  });

  it("rejects an old signature (>5min skew)", () => {
    const payload = "{}";
    const ts = Math.floor(Date.now() / 1000) - 600;
    const headers = webhookHeaders("msg_1", ts, payload);
    expect(adapter.verifyWebhook(payload, headers, SECRET)).toBe(false);
  });

  it("rejects when headers are missing", () => {
    expect(adapter.verifyWebhook("{}", {}, SECRET)).toBe(false);
  });
});

describe("Polar adapter — parseWebhookEvent", () => {
  it("maps order.paid to payment.succeeded with amount/currency", () => {
    const payload = JSON.stringify({
      type: "order.paid",
      data: {
        id: "ord_1",
        customer_id: "cus_1",
        total_amount: 2000,
        currency: "usd",
        subscription_id: "sub_1",
        metadata: { accountId: "acct-7" },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.id).toBe("ord_1");
    expect(event.type).toBe("payment.succeeded");
    expect(event.customerId).toBe("cus_1");
    expect(event.amount).toBe(2000);
    expect(event.currency).toBe("usd");
    expect(event.metadata).toEqual({ accountId: "acct-7" });
    expect(event.subscription?.id).toBe("sub_1");
  });

  it("maps subscription.updated with priceId and metadata", () => {
    const payload = JSON.stringify({
      type: "subscription.updated",
      data: {
        id: "sub_1",
        customer_id: "cus_1",
        status: "active",
        product_id: "prod_pro",
        price: { id: "price_pro", product_id: "prod_pro" },
        metadata: { accountId: "acct-3" },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("subscription.updated");
    expect(event.customerId).toBe("cus_1");
    expect(event.subscription?.priceId).toBe("price_pro");
    expect(event.subscription?.metadata).toEqual({ accountId: "acct-3" });
    expect(event.metadata).toEqual({ accountId: "acct-3" });
  });

  it("maps subscription.created and subscription.canceled", () => {
    const created = adapter.parseWebhookEvent(
      JSON.stringify({ type: "subscription.created", data: { id: "s", customer_id: "c", status: "active" } }),
      {}
    )!;
    expect(created.type).toBe("subscription.created");
    const canceled = adapter.parseWebhookEvent(
      JSON.stringify({ type: "subscription.canceled", data: { id: "s", customer_id: "c", status: "canceled" } }),
      {}
    )!;
    expect(canceled.type).toBe("subscription.canceled");
  });

  it("maps subscription.active to subscription.updated", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ type: "subscription.active", data: { id: "s", customer_id: "c", status: "active" } }),
      {}
    )!;
    expect(event.type).toBe("subscription.updated");
  });

  it("maps a paid checkout.updated to checkout.completed with priceId", () => {
    const payload = JSON.stringify({
      type: "checkout.updated",
      data: {
        id: "co_1",
        status: "succeeded",
        customer_id: "cus_1",
        product_price_id: "price_pro",
        metadata: { accountId: "acct-2" },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("checkout.completed");
    expect(event.customerId).toBe("cus_1");
    expect(event.subscription?.priceId).toBe("price_pro");
    expect(event.metadata).toEqual({ accountId: "acct-2" });
  });

  it("maps a non-paid checkout.updated to unknown", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ type: "checkout.updated", data: { id: "co_1", status: "open" } }),
      {}
    )!;
    expect(event.type).toBe("unknown");
  });

  it("maps unrecognized event types to unknown", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ type: "benefit.created", data: { id: "b1" } }),
      {}
    )!;
    expect(event.type).toBe("unknown");
  });

  it("returns null on invalid JSON", () => {
    expect(adapter.parseWebhookEvent("not json", {})).toBeNull();
  });
});
