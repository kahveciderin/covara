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

export interface PolarAdapterConfig {
  accessToken: string;
  server?: "production" | "sandbox";
}

const POLAR_API_BASE = "https://api.polar.sh";
const POLAR_SANDBOX_API_BASE = "https://sandbox-api.polar.sh";
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

interface PolarCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PolarPrice {
  id?: string;
  product_id?: string;
}

interface PolarSubscription {
  id: string;
  customer_id?: string;
  status?: string;
  quantity?: number;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  ends_at?: string | null;
  product_id?: string;
  price_id?: string;
  price?: PolarPrice | null;
  prices?: PolarPrice[];
  metadata?: Record<string, unknown> | null;
}

interface PolarList<T> {
  items?: T[];
}

interface PolarOrder {
  id?: string;
  customer_id?: string;
  amount?: number;
  total_amount?: number;
  currency?: string;
  subscription_id?: string;
  subscription?: PolarSubscription | null;
  metadata?: Record<string, unknown> | null;
}

interface PolarCheckoutObject {
  id?: string;
  url?: string;
  status?: string;
  customer_id?: string | null;
  product_id?: string | null;
  product_price_id?: string | null;
  subscription_id?: string | null;
  subscription?: PolarSubscription | null;
  amount?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown> | null;
}

const mapStatus = (status?: string): SubscriptionStatus => {
  const known: SubscriptionStatus[] = [
    "active",
    "trialing",
    "past_due",
    "canceled",
    "paused",
    "incomplete",
    "expired",
    "unpaid",
  ];
  return status && known.includes(status as SubscriptionStatus)
    ? (status as SubscriptionStatus)
    : "incomplete";
};

const toDate = (value?: string | null): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const subscriptionPriceId = (sub: PolarSubscription): string | undefined =>
  sub.price?.id ?? sub.price_id ?? sub.prices?.[0]?.id ?? sub.product_id;

const subscriptionProductId = (sub: PolarSubscription): string | undefined =>
  sub.product_id ?? sub.price?.product_id ?? sub.prices?.[0]?.product_id;

const mapSubscription = (sub: PolarSubscription): BillingSubscription => ({
  id: sub.id,
  customerId: sub.customer_id ?? "",
  status: mapStatus(sub.status),
  priceId: subscriptionPriceId(sub),
  productId: subscriptionProductId(sub),
  quantity: sub.quantity,
  currentPeriodStart: toDate(sub.current_period_start),
  currentPeriodEnd: toDate(sub.current_period_end),
  cancelAtPeriodEnd: sub.cancel_at_period_end,
  trialEndsAt: undefined,
  metadata: sub.metadata ?? undefined,
  provider: "polar",
});

const mapCustomer = (customer: PolarCustomer): BillingCustomer => ({
  id: customer.id,
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  metadata: customer.metadata ?? undefined,
  provider: "polar",
});

const mapEventType = (type: string, data: Record<string, unknown>): BillingEventType => {
  switch (type) {
    case "checkout.updated":
      return data.status === "succeeded" || data.status === "paid"
        ? "checkout.completed"
        : "unknown";
    case "subscription.created":
      return "subscription.created";
    case "subscription.active":
    case "subscription.updated":
      return "subscription.updated";
    case "subscription.canceled":
    case "subscription.revoked":
      return "subscription.canceled";
    case "order.paid":
    case "order.created":
      return "payment.succeeded";
    default:
      return "unknown";
  }
};

export class PolarBillingAdapter implements BillingAdapter {
  readonly provider = "polar" as const;
  private accessToken: string;
  private baseUrl: string;

  constructor(config: PolarAdapterConfig) {
    this.accessToken = config.accessToken;
    this.baseUrl = config.server === "sandbox" ? POLAR_SANDBOX_API_BASE : POLAR_API_BASE;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    allowNotFound = false
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    });
    if (response.status === 404 && allowNotFound) {
      return null;
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        json?.error?.message ?? json?.detail ?? `Polar request failed (${response.status})`;
      throw new BillingError(
        typeof message === "string" ? message : JSON.stringify(message),
        "polar",
        response.status
      );
    }
    return json as T;
  }

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const body: Record<string, unknown> = { email: input.email };
    if (input.name) body.name = input.name;
    if (input.metadata) body.metadata = input.metadata;
    const customer = (await this.request<PolarCustomer>("POST", "/v1/customers", body))!;
    return mapCustomer(customer);
  }

  async getCustomer(id: string): Promise<BillingCustomer | null> {
    const customer = await this.request<PolarCustomer>(
      "GET",
      `/v1/customers/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    return customer ? mapCustomer(customer) : null;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const body: Record<string, unknown> = {
      products: input.items.map((item) => item.priceId),
      success_url: input.successUrl,
    };
    if (input.customerId) body.customer_id = input.customerId;
    if (input.customerEmail) body.customer_email = input.customerEmail;
    if (input.metadata) body.metadata = input.metadata;
    const checkout = (await this.request<{ id: string; url: string }>(
      "POST",
      "/v1/checkouts/",
      body
    ))!;
    return { id: checkout.id, url: checkout.url, provider: "polar" };
  }

  async getSubscription(id: string): Promise<BillingSubscription | null> {
    const sub = await this.request<PolarSubscription>(
      "GET",
      `/v1/subscriptions/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    return sub ? mapSubscription(sub) : null;
  }

  async listSubscriptions(customerId: string): Promise<BillingSubscription[]> {
    const list = (await this.request<PolarList<PolarSubscription>>(
      "GET",
      `/v1/subscriptions/?customer_id=${encodeURIComponent(customerId)}`
    ))!;
    return (list.items ?? []).map(mapSubscription);
  }

  async cancelSubscription(
    id: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    if (options?.atPeriodEnd) {
      const sub = (await this.request<PolarSubscription>(
        "PATCH",
        `/v1/subscriptions/${encodeURIComponent(id)}`,
        { cancel_at_period_end: true }
      ))!;
      return mapSubscription(sub);
    }
    const sub = (await this.request<PolarSubscription>(
      "DELETE",
      `/v1/subscriptions/${encodeURIComponent(id)}`
    ))!;
    return mapSubscription(sub);
  }

  async updateSubscription(
    id: string,
    update: { priceId?: string; quantity?: number; cancelAtPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    const body: Record<string, unknown> = {};
    if (update.priceId !== undefined) body.product_id = update.priceId;
    if (update.cancelAtPeriodEnd !== undefined) {
      body.cancel_at_period_end = update.cancelAtPeriodEnd;
    }
    const sub = (await this.request<PolarSubscription>(
      "PATCH",
      `/v1/subscriptions/${encodeURIComponent(id)}`,
      body
    ))!;
    return mapSubscription(sub);
  }

  async reportUsage(input: ReportUsageInput): Promise<void> {
    // Polar usage-based billing is metered via event ingestion. The
    // `subscriptionItemId` is treated as the meter/event name and the quantity
    // is recorded under the conventional `units` metadata key. Assumption: the
    // ingestion endpoint is POST /v1/events/ingest with an `events` array of
    // { name, metadata } objects (Polar's Standard event ingest shape).
    const event: Record<string, unknown> = {
      name: input.subscriptionItemId,
      metadata: { units: input.quantity },
    };
    if (input.timestamp) {
      event.timestamp = input.timestamp.toISOString();
    }
    await this.request("POST", "/v1/events/ingest", { events: [event] });
  }

  async createPortalSession(customerId: string, _returnUrl: string): Promise<PortalSession> {
    const session = (await this.request<{ customer_portal_url?: string; url?: string }>(
      "POST",
      "/v1/customer-sessions/",
      { customer_id: customerId }
    ))!;
    const url = session.customer_portal_url ?? session.url ?? "";
    return { url };
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    const id = headers["webhook-id"] ?? headers["Webhook-Id"];
    const timestamp = headers["webhook-timestamp"] ?? headers["Webhook-Timestamp"];
    const signatureHeader = headers["webhook-signature"] ?? headers["Webhook-Signature"];
    if (!id || !timestamp || !signatureHeader) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false;

    let key: Buffer;
    try {
      key = secret.startsWith("whsec_")
        ? Buffer.from(secret.slice("whsec_".length), "base64")
        : Buffer.from(secret);
    } catch {
      return false;
    }

    const expected = createHmac("sha256", key)
      .update(`${id}.${timestamp}.${payload}`)
      .digest("base64");
    const expectedBuf = Buffer.from(expected);

    const signatures = signatureHeader
      .split(" ")
      .map((entry) => {
        const [, sig] = entry.split(",", 2);
        return sig ?? entry;
      })
      .filter((sig) => sig.length > 0);

    return signatures.some((sig) => {
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
  }

  parseWebhookEvent(payload: string, _headers: Record<string, string>): BillingEvent | null {
    let parsed: { type?: string; data?: unknown; id?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.type !== "string") return null;

    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const type = mapEventType(parsed.type, data);

    const event: BillingEvent = {
      id: (data.id as string | undefined) ?? parsed.id ?? "",
      type,
      provider: "polar",
      raw: parsed,
    };

    event.customerId = (data.customer_id as string | undefined) ?? undefined;
    event.metadata = (data.metadata as Record<string, unknown> | undefined) ?? undefined;

    if (parsed.type.startsWith("subscription.")) {
      const sub = data as unknown as PolarSubscription;
      event.subscription = mapSubscription(sub);
      event.customerId = sub.customer_id ?? event.customerId;
      event.metadata = sub.metadata ?? event.metadata;
    } else if (parsed.type.startsWith("order.")) {
      const order = data as unknown as PolarOrder;
      event.customerId = order.customer_id ?? event.customerId;
      event.amount = order.total_amount ?? order.amount;
      event.currency = order.currency ?? undefined;
      event.metadata = order.metadata ?? event.metadata;
      if (order.subscription) {
        event.subscription = mapSubscription(order.subscription);
      } else if (order.subscription_id) {
        event.subscription = {
          id: order.subscription_id,
          customerId: order.customer_id ?? "",
          status: "active",
          metadata: order.metadata ?? undefined,
          provider: "polar",
        };
      }
    } else if (parsed.type.startsWith("checkout.")) {
      const checkout = data as unknown as PolarCheckoutObject;
      event.customerId = checkout.customer_id ?? event.customerId;
      event.amount = checkout.amount ?? undefined;
      event.currency = checkout.currency ?? undefined;
      event.metadata = checkout.metadata ?? event.metadata;
      if (checkout.subscription) {
        event.subscription = mapSubscription(checkout.subscription);
      } else {
        const priceId =
          checkout.product_price_id ?? checkout.product_id ?? undefined;
        if (priceId || checkout.subscription_id) {
          event.subscription = {
            id: checkout.subscription_id ?? "",
            customerId: checkout.customer_id ?? "",
            status: "active",
            priceId: priceId ?? undefined,
            metadata: checkout.metadata ?? undefined,
            provider: "polar",
          };
        }
      }
    }

    return event;
  }
}

export const createPolarAdapter = (config: PolarAdapterConfig): BillingAdapter =>
  new PolarBillingAdapter(config);
