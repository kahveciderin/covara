import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createLemonSqueezyAdapter } from "@/billing/lemonsqueezy";

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

const adapter = createLemonSqueezyAdapter({ apiKey: "ls_test_123", storeId: 42 });

beforeEach(() => {
  calls.length = 0;
  nextResponses = [];
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockClear();
});

describe("Lemon Squeezy adapter — customers", () => {
  it("creates a customer with JSON:API body and headers", async () => {
    queue({ data: { type: "customers", id: "1", attributes: { email: "a@b.c", name: "Ann" } } });
    const customer = await adapter.createCustomer({ email: "a@b.c", name: "Ann" });

    const call = calls[0];
    expect(call.url).toBe("https://api.lemonsqueezy.com/v1/customers");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer ls_test_123");
    expect(call.headers.Accept).toBe("application/vnd.api+json");
    expect(call.headers["Content-Type"]).toBe("application/vnd.api+json");
    const body = jsonBody(call.body) as {
      data: { type: string; attributes: Record<string, string>; relationships: any };
    };
    expect(body.data.type).toBe("customers");
    expect(body.data.attributes.email).toBe("a@b.c");
    expect(body.data.attributes.name).toBe("Ann");
    expect(body.data.relationships.store.data.id).toBe("42");

    expect(customer).toEqual({ id: "1", email: "a@b.c", name: "Ann", provider: "lemonsqueezy" });
  });

  it("returns null on 404 for getCustomer", async () => {
    queue({ errors: [{ detail: "no" }] }, 404);
    expect(await adapter.getCustomer("999")).toBeNull();
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/customers/999");
    expect(calls[0].method).toBe("GET");
  });
});

describe("Lemon Squeezy adapter — checkout", () => {
  it("creates a checkout for a variant with custom data and redirect url", async () => {
    queue({
      data: { type: "checkouts", id: "co_1", attributes: { url: "https://store.lemonsqueezy.com/checkout/co_1" } },
    });
    const session = await adapter.createCheckout({
      mode: "subscription",
      items: [{ priceId: "variant_99" }],
      customerEmail: "user@x.com",
      successUrl: "https://app/ok",
      metadata: { accountId: "acct-1", nested: { a: 1 } },
    });

    const call = calls[0];
    expect(call.url).toBe("https://api.lemonsqueezy.com/v1/checkouts");
    const body = jsonBody(call.body) as {
      data: { type: string; attributes: any; relationships: any };
    };
    expect(body.data.type).toBe("checkouts");
    expect(body.data.relationships.store.data.id).toBe("42");
    expect(body.data.relationships.variant.data.id).toBe("variant_99");
    expect(body.data.attributes.checkout_data.email).toBe("user@x.com");
    expect(body.data.attributes.checkout_data.custom.accountId).toBe("acct-1");
    expect(body.data.attributes.checkout_data.custom.nested).toBe(JSON.stringify({ a: 1 }));
    expect(body.data.attributes.product_options.redirect_url).toBe("https://app/ok");

    expect(session).toEqual({
      id: "co_1",
      url: "https://store.lemonsqueezy.com/checkout/co_1",
      provider: "lemonsqueezy",
    });
  });

  it("throws when no variant id is provided", async () => {
    await expect(
      adapter.createCheckout({ mode: "payment", items: [], successUrl: "https://app/ok" })
    ).rejects.toThrow("variant id");
  });
});

describe("Lemon Squeezy adapter — subscriptions", () => {
  const rawSub = {
    data: {
      type: "subscriptions",
      id: "sub_1",
      attributes: {
        customer_id: 7,
        variant_id: 99,
        product_id: 5,
        status: "active",
        cancelled: false,
        created_at: "2024-01-01T00:00:00Z",
        renews_at: "2024-02-01T00:00:00Z",
        ends_at: null,
        trial_ends_at: null,
      },
    },
  };

  it("gets and maps a subscription", async () => {
    queue(rawSub);
    const sub = await adapter.getSubscription("sub_1");
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/subscriptions/sub_1");
    expect(sub).toMatchObject({
      id: "sub_1",
      customerId: "7",
      status: "active",
      priceId: "99",
      productId: "5",
      cancelAtPeriodEnd: false,
      provider: "lemonsqueezy",
    });
    expect(sub?.currentPeriodStart).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(sub?.currentPeriodEnd).toEqual(new Date("2024-02-01T00:00:00Z"));
  });

  it("maps on_trial to trialing and cancelled to canceled", async () => {
    queue({ data: { ...rawSub.data, attributes: { ...rawSub.data.attributes, status: "on_trial" } } });
    expect((await adapter.getSubscription("sub_1"))?.status).toBe("trialing");
    queue({ data: { ...rawSub.data, attributes: { ...rawSub.data.attributes, status: "cancelled" } } });
    expect((await adapter.getSubscription("sub_1"))?.status).toBe("canceled");
  });

  it("sets cancelAtPeriodEnd when cancelled with an ends_at", async () => {
    queue({
      data: {
        ...rawSub.data,
        attributes: { ...rawSub.data.attributes, cancelled: true, ends_at: "2024-03-01T00:00:00Z" },
      },
    });
    const sub = await adapter.getSubscription("sub_1");
    expect(sub?.cancelAtPeriodEnd).toBe(true);
    expect(sub?.status).toBe("active");
  });

  it("lists subscriptions filtered by customer", async () => {
    queue({ data: [rawSub.data, { ...rawSub.data, id: "sub_2" }] });
    const subs = await adapter.listSubscriptions("7");
    expect(calls[0].url).toContain("/subscriptions?filter[customer_id]=7");
    expect(subs).toHaveLength(2);
    expect(subs[1].id).toBe("sub_2");
  });

  it("cancels with DELETE (at period end)", async () => {
    queue({ data: { ...rawSub.data, attributes: { ...rawSub.data.attributes, status: "cancelled", cancelled: true, ends_at: "2024-03-01T00:00:00Z" } } });
    const sub = await adapter.cancelSubscription("sub_1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/subscriptions/sub_1");
    expect(sub.status).toBe("canceled");
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("updates the variant via PATCH", async () => {
    queue(rawSub);
    await adapter.updateSubscription("sub_1", { priceId: "123" });
    expect(calls[0].method).toBe("PATCH");
    const body = jsonBody(calls[0].body) as { data: { id: string; attributes: any } };
    expect(body.data.id).toBe("sub_1");
    expect(body.data.attributes.variant_id).toBe(123);
  });
});

describe("Lemon Squeezy adapter — usage and portal", () => {
  it("reports usage to the usage-records endpoint", async () => {
    queue({ data: { type: "usage-records", id: "ur_1" } });
    await adapter.reportUsage({ subscriptionItemId: "si_1", quantity: 10, action: "set" });
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/usage-records");
    expect(calls[0].method).toBe("POST");
    const body = jsonBody(calls[0].body) as { data: { attributes: any; relationships: any } };
    expect(body.data.attributes.quantity).toBe(10);
    expect(body.data.attributes.action).toBe("set");
    expect(body.data.relationships["subscription-item"].data.id).toBe("si_1");
  });

  it("returns the customer portal url", async () => {
    queue({
      data: { type: "customers", id: "7", attributes: { urls: { customer_portal: "https://portal/x" } } },
    });
    const portal = await adapter.createPortalSession!("7", "https://app/back");
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/customers/7");
    expect(portal).toEqual({ url: "https://portal/x" });
  });
});

describe("Lemon Squeezy adapter — errors", () => {
  it("throws BillingError on non-ok non-404 responses", async () => {
    queue({ errors: [{ detail: "bad variant" }] }, 422);
    await expect(
      adapter.createCheckout({ mode: "subscription", items: [{ priceId: "v1" }], successUrl: "https://app/ok" })
    ).rejects.toThrow("bad variant");
  });
});

const SECRET = "ls_whsec_test";

const sign = (payload: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

describe("Lemon Squeezy adapter — verifyWebhook", () => {
  it("accepts a valid signature", () => {
    const payload = JSON.stringify({ meta: { event_name: "subscription_created" } });
    expect(adapter.verifyWebhook(payload, { "x-signature": sign(payload) }, SECRET)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ meta: { event_name: "subscription_created" } });
    const header = sign(payload);
    expect(adapter.verifyWebhook("{}", { "x-signature": header }, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const payload = "{}";
    expect(adapter.verifyWebhook(payload, { "x-signature": sign(payload, "other") }, SECRET)).toBe(false);
  });

  it("rejects when header is missing", () => {
    expect(adapter.verifyWebhook("{}", {}, SECRET)).toBe(false);
  });
});

describe("Lemon Squeezy adapter — parseWebhookEvent", () => {
  it("maps subscription_created with priceId and custom metadata", () => {
    const payload = JSON.stringify({
      meta: { event_name: "subscription_created", custom_data: { accountId: "acct-3" } },
      data: {
        type: "subscriptions",
        id: "sub_1",
        attributes: { customer_id: 7, variant_id: 99, status: "active" },
      },
    });
    const event = adapter.parseWebhookEvent(payload, {})!;
    expect(event.type).toBe("subscription.created");
    expect(event.id).toBe("subscription_created:sub_1");
    expect(event.customerId).toBe("7");
    expect(event.subscription?.priceId).toBe("99");
    expect(event.subscription?.metadata).toEqual({ accountId: "acct-3" });
    expect(event.metadata).toEqual({ accountId: "acct-3" });
  });

  it("maps subscription_cancelled to subscription.canceled", () => {
    const payload = JSON.stringify({
      meta: { event_name: "subscription_cancelled" },
      data: { id: "sub_1", attributes: { customer_id: 7, status: "cancelled" } },
    });
    expect(adapter.parseWebhookEvent(payload, {})!.type).toBe("subscription.canceled");
  });

  it("maps order_created and subscription_payment_success to payment.succeeded", () => {
    const order = adapter.parseWebhookEvent(
      JSON.stringify({
        meta: { event_name: "order_created", custom_data: { userId: "u1" } },
        data: { id: "ord_1", attributes: { customer_id: 7, variant_id: 99 } },
      }),
      {}
    )!;
    expect(order.type).toBe("payment.succeeded");
    expect(order.customerId).toBe("7");
    expect(order.subscription?.priceId).toBe("99");
    expect(order.metadata).toEqual({ userId: "u1" });

    const pay = adapter.parseWebhookEvent(
      JSON.stringify({
        meta: { event_name: "subscription_payment_success" },
        data: { id: "si_1", attributes: { customer_id: 7, variant_id: 99 } },
      }),
      {}
    )!;
    expect(pay.type).toBe("payment.succeeded");
  });

  it("maps subscription_payment_failed to payment.failed", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({
        meta: { event_name: "subscription_payment_failed" },
        data: { id: "si_1", attributes: { customer_id: 7 } },
      }),
      {}
    )!;
    expect(event.type).toBe("payment.failed");
  });

  it("maps unknown event names to unknown", () => {
    const event = adapter.parseWebhookEvent(
      JSON.stringify({ meta: { event_name: "license_key_created" }, data: { id: "x", attributes: {} } }),
      {}
    )!;
    expect(event.type).toBe("unknown");
  });

  it("returns null on invalid JSON or missing meta", () => {
    expect(adapter.parseWebhookEvent("not json", {})).toBeNull();
    expect(adapter.parseWebhookEvent(JSON.stringify({ data: {} }), {})).toBeNull();
  });
});
