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
  ReportUsageInput,
  SubscriptionStatus,
} from "./types";

export interface PaddleAdapterConfig {
  apiKey: string;
  sandbox?: boolean;
}

const PADDLE_API_BASE = "https://api.paddle.com";
const PADDLE_SANDBOX_API_BASE = "https://sandbox-api.paddle.com";
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

interface PaddleCustomer {
  id?: string;
  email?: string | null;
  name?: string | null;
  custom_data?: Record<string, unknown> | null;
}

interface PaddlePrice {
  id?: string;
  product_id?: string;
}

interface PaddleSubscriptionItem {
  quantity?: number;
  price?: PaddlePrice;
}

interface PaddleSubscription {
  id?: string;
  customer_id?: string;
  status?: string;
  items?: PaddleSubscriptionItem[];
  current_billing_period?: { starts_at?: string; ends_at?: string };
  scheduled_change?: { action?: string; effective_at?: string } | null;
  trial_dates?: { ends_at?: string } | null;
  custom_data?: Record<string, unknown> | null;
}

interface PaddleTransaction {
  id?: string;
  customer_id?: string;
  currency_code?: string;
  custom_data?: Record<string, unknown> | null;
  checkout?: { url?: string | null } | null;
  details?: { totals?: { total?: string } } | null;
  items?: Array<{ price?: PaddlePrice }>;
}

interface PaddleEnvelope<T> {
  data?: T;
}

const mapStatus = (status?: string): SubscriptionStatus => {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "paused":
      return "paused";
    default:
      return "active";
  }
};

const toDate = (value?: string | null): Date | undefined =>
  value ? new Date(value) : undefined;

const mapCustomer = (customer: PaddleCustomer): BillingCustomer => ({
  id: customer.id ?? "",
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  metadata: customer.custom_data ?? undefined,
  provider: "paddle",
});

const mapSubscription = (sub: PaddleSubscription): BillingSubscription => {
  const item = sub.items?.[0];
  return {
    id: sub.id ?? "",
    customerId: sub.customer_id ?? "",
    status: mapStatus(sub.status),
    priceId: item?.price?.id,
    productId: item?.price?.product_id,
    quantity: item?.quantity,
    currentPeriodStart: toDate(sub.current_billing_period?.starts_at),
    currentPeriodEnd: toDate(sub.current_billing_period?.ends_at),
    cancelAtPeriodEnd: sub.scheduled_change?.action === "cancel",
    trialEndsAt: toDate(sub.trial_dates?.ends_at),
    metadata: sub.custom_data ?? undefined,
    provider: "paddle",
  };
};

const mapEventType = (type?: string): BillingEventType => {
  switch (type) {
    case "transaction.completed":
    case "transaction.paid":
      return "payment.succeeded";
    case "transaction.payment_failed":
      return "payment.failed";
    case "subscription.created":
      return "subscription.created";
    case "subscription.updated":
      return "subscription.updated";
    case "subscription.canceled":
      return "subscription.canceled";
    default:
      return "unknown";
  }
};

export class PaddleBillingAdapter implements BillingAdapter {
  readonly provider = "paddle" as const;
  private apiKey: string;
  private base: string;

  constructor(config: PaddleAdapterConfig) {
    this.apiKey = config.apiKey;
    this.base = config.sandbox ? PADDLE_SANDBOX_API_BASE : PADDLE_API_BASE;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    if (response.status === 404 && allowNotFound) return null;
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = json?.error?.detail ?? `Paddle request failed (${response.status})`;
      throw new BillingError(message, "paddle", response.status);
    }
    return json as T;
  }

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const body: Record<string, unknown> = { email: input.email };
    if (input.name) body.name = input.name;
    if (input.metadata) body.custom_data = input.metadata;
    const envelope = (await this.request<PaddleEnvelope<PaddleCustomer>>(
      "POST",
      "/customers",
      body
    ))!;
    return mapCustomer(envelope.data ?? {});
  }

  async getCustomer(id: string): Promise<BillingCustomer | null> {
    const envelope = await this.request<PaddleEnvelope<PaddleCustomer>>(
      "GET",
      `/customers/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (!envelope) return null;
    return mapCustomer(envelope.data ?? {});
  }

  // Paddle's primary checkout flow is client-side Paddle.js with a price id, but
  // creating a transaction via the API returns a hosted checkout url which we
  // return here. For the Paddle.js flow, pass items[].priceId to Paddle.Checkout.
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const body: Record<string, unknown> = {
      items: input.items.map((item) => ({
        price_id: item.priceId,
        quantity: item.quantity ?? 1,
      })),
    };
    if (input.customerId) body.customer_id = input.customerId;
    if (input.customerEmail && !input.customerId) {
      body.customer = { email: input.customerEmail };
    }
    if (input.metadata) body.custom_data = input.metadata;
    const envelope = (await this.request<PaddleEnvelope<PaddleTransaction>>(
      "POST",
      "/transactions",
      body
    ))!;
    const txn = envelope.data ?? {};
    return {
      id: txn.id ?? "",
      url: txn.checkout?.url ?? "",
      provider: "paddle",
    };
  }

  async getSubscription(id: string): Promise<BillingSubscription | null> {
    const envelope = await this.request<PaddleEnvelope<PaddleSubscription>>(
      "GET",
      `/subscriptions/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (!envelope) return null;
    return mapSubscription(envelope.data ?? {});
  }

  async listSubscriptions(customerId: string): Promise<BillingSubscription[]> {
    const envelope = (await this.request<PaddleEnvelope<PaddleSubscription[]>>(
      "GET",
      `/subscriptions?customer_id=${encodeURIComponent(customerId)}`
    ))!;
    return (envelope.data ?? []).map(mapSubscription);
  }

  async cancelSubscription(
    id: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    const envelope = (await this.request<PaddleEnvelope<PaddleSubscription>>(
      "POST",
      `/subscriptions/${encodeURIComponent(id)}/cancel`,
      { effective_from: options?.atPeriodEnd ? "next_billing_period" : "immediately" }
    ))!;
    return mapSubscription(envelope.data ?? {});
  }

  async updateSubscription(
    id: string,
    update: { priceId?: string; quantity?: number; cancelAtPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    const body: Record<string, unknown> = {};
    if (update.priceId !== undefined) {
      body.items = [{ price_id: update.priceId, quantity: update.quantity ?? 1 }];
      body.proration_billing_mode = "prorated_immediately";
    }
    if (update.cancelAtPeriodEnd !== undefined) {
      body.scheduled_change = update.cancelAtPeriodEnd
        ? { action: "cancel", effective_at: "next_billing_period" }
        : null;
    }
    const envelope = (await this.request<PaddleEnvelope<PaddleSubscription>>(
      "PATCH",
      `/subscriptions/${encodeURIComponent(id)}`,
      body
    ))!;
    return mapSubscription(envelope.data ?? {});
  }

  // Paddle usage-based billing is configured on the price itself; there is no
  // portable per-item usage reporting endpoint equivalent to Stripe's.
  async reportUsage(_input: ReportUsageInput): Promise<void> {
    throw new BillingError(
      "Paddle usage reporting is managed via prices; not supported via reportUsage",
      "paddle"
    );
  }

  // Paddle has no direct portal-session API; the customer portal is configured in
  // the dashboard. createPortalSession is intentionally omitted.

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    const header = headers["paddle-signature"] ?? headers["Paddle-Signature"];
    if (!header) return false;

    let ts: string | undefined;
    let h1: string | undefined;
    for (const part of header.split(";")) {
      const [key, value] = part.split("=");
      if (key === "ts") ts = value;
      else if (key === "h1") h1 = value;
    }
    if (!ts || !h1) return false;

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false;

    const expected = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(h1, "hex");
    } catch {
      return false;
    }
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  }

  parseWebhookEvent(payload: string, _headers: Record<string, string>): BillingEvent | null {
    let parsed: {
      event_id?: string;
      event_type?: string;
      data?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.event_type !== "string") return null;

    const type = mapEventType(parsed.event_type);
    const data = parsed.data ?? {};
    const custom = (data.custom_data as Record<string, unknown> | undefined) ?? undefined;

    const event: BillingEvent = {
      id: parsed.event_id ?? "",
      type,
      provider: "paddle",
      customerId: data.customer_id as string | undefined,
      metadata: custom,
      raw: parsed,
    };

    if (parsed.event_type.startsWith("subscription.")) {
      event.subscription = mapSubscription(data as PaddleSubscription);
      event.customerId = event.subscription.customerId || event.customerId;
    } else if (parsed.event_type.startsWith("transaction.")) {
      const txn = data as PaddleTransaction;
      event.currency = txn.currency_code;
      const total = txn.details?.totals?.total;
      if (total !== undefined) {
        const amount = Number(total);
        if (Number.isFinite(amount)) event.amount = amount;
      }
      const priceId = txn.items?.[0]?.price?.id;
      if (priceId) {
        event.subscription = {
          id: "",
          customerId: (txn.customer_id as string) ?? "",
          status: "active",
          priceId,
          metadata: custom,
          provider: "paddle",
        };
      }
    }

    return event;
  }
}

export const createPaddleAdapter = (config: PaddleAdapterConfig): BillingAdapter =>
  new PaddleBillingAdapter(config);
