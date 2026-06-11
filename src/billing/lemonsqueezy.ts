import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BillingAdapter,
  BillingCustomer,
  BillingError,
  BillingEvent,
  BillingEventType,
  BillingSubscription,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  PortalSession,
  ReportUsageInput,
  SubscriptionStatus,
} from "./types";

export interface LemonSqueezyAdapterConfig {
  apiKey: string;
  storeId: string | number;
}

const LS_API_BASE = "https://api.lemonsqueezy.com/v1";
const JSON_API_CONTENT_TYPE = "application/vnd.api+json";

interface JsonApiResource<A = Record<string, unknown>> {
  type?: string;
  id?: string;
  attributes?: A;
}

interface JsonApiDocument<A = Record<string, unknown>> {
  data?: JsonApiResource<A> | JsonApiResource<A>[];
}

interface LSCustomerAttributes {
  store_id?: number;
  name?: string | null;
  email?: string | null;
  status?: string;
  urls?: { customer_portal?: string };
}

interface LSSubscriptionAttributes {
  store_id?: number;
  customer_id?: number;
  order_id?: number;
  variant_id?: number;
  product_id?: number;
  status?: string;
  cancelled?: boolean;
  trial_ends_at?: string | null;
  renews_at?: string | null;
  ends_at?: string | null;
  created_at?: string | null;
  first_subscription_item?: { id?: number; subscription_id?: number; price_id?: number };
  urls?: { customer_portal?: string; update_payment_method?: string };
}

const mapStatus = (status?: string): SubscriptionStatus => {
  switch (status) {
    case "active":
      return "active";
    case "on_trial":
      return "trialing";
    case "past_due":
      return "past_due";
    case "cancelled":
      return "canceled";
    case "paused":
      return "paused";
    case "expired":
      return "expired";
    case "unpaid":
      return "unpaid";
    default:
      return "active";
  }
};

const toDate = (value?: string | null): Date | undefined =>
  value ? new Date(value) : undefined;

const idStr = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value);

const mapCustomer = (resource: JsonApiResource<LSCustomerAttributes>): BillingCustomer => ({
  id: resource.id ?? "",
  email: resource.attributes?.email ?? undefined,
  name: resource.attributes?.name ?? undefined,
  provider: "lemonsqueezy",
});

const mapSubscription = (
  resource: JsonApiResource<LSSubscriptionAttributes>,
  metadata?: Record<string, unknown>
): BillingSubscription => {
  const attrs = resource.attributes ?? {};
  const cancelAtPeriodEnd = Boolean(attrs.cancelled && attrs.ends_at);
  return {
    id: resource.id ?? "",
    customerId: idStr(attrs.customer_id) ?? "",
    status: mapStatus(attrs.status),
    priceId: idStr(attrs.variant_id),
    productId: idStr(attrs.product_id),
    currentPeriodStart: toDate(attrs.created_at),
    currentPeriodEnd: toDate(attrs.renews_at ?? attrs.ends_at),
    cancelAtPeriodEnd,
    trialEndsAt: toDate(attrs.trial_ends_at),
    metadata,
    provider: "lemonsqueezy",
  };
};

const mapEventType = (name?: string): BillingEventType => {
  switch (name) {
    case "subscription_created":
      return "subscription.created";
    case "subscription_updated":
      return "subscription.updated";
    case "subscription_cancelled":
      return "subscription.canceled";
    case "order_created":
    case "subscription_payment_success":
      return "payment.succeeded";
    case "subscription_payment_failed":
      return "payment.failed";
    default:
      return "unknown";
  }
};

export class LemonSqueezyBillingAdapter implements BillingAdapter {
  readonly provider = "lemonsqueezy" as const;
  private apiKey: string;
  private storeId: string;

  constructor(config: LemonSqueezyAdapterConfig) {
    this.apiKey = config.apiKey;
    this.storeId = String(config.storeId);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: JSON_API_CONTENT_TYPE,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = JSON_API_CONTENT_TYPE;
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${LS_API_BASE}${path}`, { method, headers, body: payload });
    if (response.status === 404 && allowNotFound) return null;
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        json?.errors?.[0]?.detail ?? `Lemon Squeezy request failed (${response.status})`;
      throw new BillingError(message, "lemonsqueezy", response.status);
    }
    return json as T;
  }

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const body = {
      data: {
        type: "customers",
        attributes: {
          name: input.name ?? input.email,
          email: input.email,
        },
        relationships: {
          store: { data: { type: "stores", id: this.storeId } },
        },
      },
    };
    const doc = (await this.request<JsonApiDocument<LSCustomerAttributes>>(
      "POST",
      "/customers",
      body
    ))!;
    return mapCustomer(doc.data as JsonApiResource<LSCustomerAttributes>);
  }

  async getCustomer(id: string): Promise<BillingCustomer | null> {
    const doc = await this.request<JsonApiDocument<LSCustomerAttributes>>(
      "GET",
      `/customers/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (!doc) return null;
    return mapCustomer(doc.data as JsonApiResource<LSCustomerAttributes>);
  }

  // Lemon Squeezy is variant-based: the subscription/payment mode is implicit in
  // the chosen variant, so we accept both modes and use items[0].priceId as the
  // variant id.
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const variantId = input.items[0]?.priceId;
    if (!variantId) {
      throw new BillingError("createCheckout requires a variant id", "lemonsqueezy");
    }
    const custom: Record<string, string> = {};
    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) {
        if (value === undefined || value === null) continue;
        custom[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
      }
    }
    const checkoutData: Record<string, unknown> = {};
    if (input.customerEmail) checkoutData.email = input.customerEmail;
    if (Object.keys(custom).length > 0) checkoutData.custom = custom;
    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: checkoutData,
          product_options: { redirect_url: input.successUrl },
        },
        relationships: {
          store: { data: { type: "stores", id: this.storeId } },
          variant: { data: { type: "variants", id: String(variantId) } },
        },
      },
    };
    const doc = (await this.request<JsonApiDocument<{ url?: string }>>(
      "POST",
      "/checkouts",
      body
    ))!;
    const resource = doc.data as JsonApiResource<{ url?: string }>;
    return {
      id: resource.id ?? "",
      url: resource.attributes?.url ?? "",
      provider: "lemonsqueezy",
    };
  }

  async getSubscription(id: string): Promise<BillingSubscription | null> {
    const doc = await this.request<JsonApiDocument<LSSubscriptionAttributes>>(
      "GET",
      `/subscriptions/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (!doc) return null;
    return mapSubscription(doc.data as JsonApiResource<LSSubscriptionAttributes>);
  }

  async listSubscriptions(customerId: string): Promise<BillingSubscription[]> {
    const doc = (await this.request<JsonApiDocument<LSSubscriptionAttributes>>(
      "GET",
      `/subscriptions?filter[customer_id]=${encodeURIComponent(customerId)}`
    ))!;
    const data = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
    return data.map((r) => mapSubscription(r));
  }

  // Lemon Squeezy cancels at the end of the current billing period.
  async cancelSubscription(id: string): Promise<BillingSubscription> {
    const doc = (await this.request<JsonApiDocument<LSSubscriptionAttributes>>(
      "DELETE",
      `/subscriptions/${encodeURIComponent(id)}`
    ))!;
    return mapSubscription(doc.data as JsonApiResource<LSSubscriptionAttributes>);
  }

  async updateSubscription(
    id: string,
    update: { priceId?: string; quantity?: number; cancelAtPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    const attributes: Record<string, unknown> = {};
    if (update.priceId !== undefined) attributes.variant_id = Number(update.priceId);
    if (update.cancelAtPeriodEnd !== undefined) attributes.cancelled = update.cancelAtPeriodEnd;
    const body = {
      data: {
        type: "subscriptions",
        id: String(id),
        attributes,
      },
    };
    const doc = (await this.request<JsonApiDocument<LSSubscriptionAttributes>>(
      "PATCH",
      `/subscriptions/${encodeURIComponent(id)}`,
      body
    ))!;
    return mapSubscription(doc.data as JsonApiResource<LSSubscriptionAttributes>);
  }

  async reportUsage(input: ReportUsageInput): Promise<void> {
    const body = {
      data: {
        type: "usage-records",
        attributes: {
          quantity: input.quantity,
          action: input.action ?? "increment",
        },
        relationships: {
          "subscription-item": {
            data: { type: "subscription-items", id: String(input.subscriptionItemId) },
          },
        },
      },
    };
    await this.request("POST", "/usage-records", body);
  }

  async createPortalSession(customerId: string): Promise<PortalSession> {
    const doc = (await this.request<JsonApiDocument<LSCustomerAttributes>>(
      "GET",
      `/customers/${encodeURIComponent(customerId)}`
    ))!;
    const resource = doc.data as JsonApiResource<LSCustomerAttributes>;
    const url = resource.attributes?.urls?.customer_portal;
    if (!url) {
      throw new BillingError(
        "Lemon Squeezy customer has no portal url",
        "lemonsqueezy"
      );
    }
    return { url };
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    const signature = headers["x-signature"] ?? headers["X-Signature"];
    if (!signature) return false;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(signature, "hex");
    } catch {
      return false;
    }
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  }

  parseWebhookEvent(payload: string, _headers: Record<string, string>): BillingEvent | null {
    let parsed: {
      meta?: { event_name?: string; custom_data?: Record<string, unknown> };
      data?: JsonApiResource<LSSubscriptionAttributes>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!parsed || !parsed.meta || typeof parsed.meta.event_name !== "string") return null;

    const eventName = parsed.meta.event_name;
    const custom = parsed.meta.custom_data;
    const data = parsed.data;
    const type = mapEventType(eventName);

    const event: BillingEvent = {
      id: `${eventName}:${data?.id ?? ""}`,
      type,
      provider: "lemonsqueezy",
      metadata: custom,
      raw: parsed,
    };

    if (data) {
      const attrs = data.attributes ?? {};
      if (eventName.startsWith("subscription")) {
        event.subscription = mapSubscription(data, custom);
        event.customerId = idStr(attrs.customer_id);
      } else {
        event.customerId = idStr(attrs.customer_id);
        if (attrs.variant_id !== undefined) {
          event.subscription = {
            id: data.id ?? "",
            customerId: idStr(attrs.customer_id) ?? "",
            status: "active",
            priceId: idStr(attrs.variant_id),
            metadata: custom,
            provider: "lemonsqueezy",
          };
        }
      }
    }

    return event;
  }
}

export const createLemonSqueezyAdapter = (
  config: LemonSqueezyAdapterConfig
): BillingAdapter => new LemonSqueezyBillingAdapter(config);
