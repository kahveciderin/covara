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

export interface StripeAdapterConfig {
  apiKey: string;
  apiVersion?: string;
}

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

type FormValue = string | number | boolean | null | undefined | FormObject | FormArray;
interface FormObject {
  [key: string]: FormValue;
}
type FormArray = FormValue[];

const encodeForm = (data: FormObject): string => {
  const params: string[] = [];
  const walk = (prefix: string, value: FormValue): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(`${prefix}[${key}]`, child as FormValue);
      }
      return;
    }
    params.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(data)) {
    walk(key, value);
  }
  return params.join("&");
};

const metadataToForm = (metadata?: Record<string, unknown>): FormObject | undefined => {
  if (!metadata) return undefined;
  const out: FormObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "object" ? JSON.stringify(value) : (value as FormValue);
  }
  return out;
};

interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  trial_end?: number | null;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ id?: string; quantity?: number; price?: { id?: string; product?: string } }> };
}

interface StripeList<T> {
  data?: T[];
}

interface StripeInvoice {
  id?: string;
  customer?: string;
  amount_paid?: number;
  amount_due?: number;
  total?: number;
  currency?: string;
  subscription?: string;
  metadata?: Record<string, string>;
  lines?: { data?: Array<{ price?: { id?: string } }> };
}

interface StripeCheckoutSessionObject {
  id?: string;
  customer?: string;
  subscription?: string | StripeSubscription;
  metadata?: Record<string, string>;
  amount_total?: number;
  currency?: string;
}

const mapStatus = (status: string): SubscriptionStatus => {
  if (status === "incomplete_expired") return "expired";
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
  return known.includes(status as SubscriptionStatus) ? (status as SubscriptionStatus) : "incomplete";
};

const toDate = (seconds?: number | null): Date | undefined =>
  typeof seconds === "number" ? new Date(seconds * 1000) : undefined;

const mapSubscription = (sub: StripeSubscription): BillingSubscription => {
  const firstItem = sub.items?.data?.[0];
  return {
    id: sub.id,
    customerId: sub.customer,
    status: mapStatus(sub.status),
    priceId: firstItem?.price?.id,
    productId: firstItem?.price?.product,
    quantity: firstItem?.quantity,
    currentPeriodStart: toDate(sub.current_period_start),
    currentPeriodEnd: toDate(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    trialEndsAt: toDate(sub.trial_end),
    metadata: sub.metadata,
    provider: "stripe",
  };
};

const mapCustomer = (customer: StripeCustomer): BillingCustomer => ({
  id: customer.id,
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  metadata: customer.metadata,
  provider: "stripe",
});

const mapEventType = (type: string): BillingEventType => {
  switch (type) {
    case "checkout.session.completed":
      return "checkout.completed";
    case "customer.subscription.created":
      return "subscription.created";
    case "customer.subscription.updated":
      return "subscription.updated";
    case "customer.subscription.deleted":
      return "subscription.canceled";
    case "invoice.payment_succeeded":
    case "invoice.paid":
      return "payment.succeeded";
    case "invoice.payment_failed":
      return "payment.failed";
    default:
      return "unknown";
  }
};

export class StripeBillingAdapter implements BillingAdapter {
  readonly provider = "stripe" as const;
  private apiKey: string;
  private apiVersion?: string;

  constructor(config: StripeAdapterConfig) {
    this.apiKey = config.apiKey;
    this.apiVersion = config.apiVersion;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: FormObject,
    allowNotFound = false
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.apiVersion) {
      headers["Stripe-Version"] = this.apiVersion;
    }
    let payload: string | undefined;
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = encodeForm(body);
    }
    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
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
      const message = json?.error?.message ?? `Stripe request failed (${response.status})`;
      throw new BillingError(message, "stripe", response.status);
    }
    return json as T;
  }

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const body: FormObject = { email: input.email };
    if (input.name) body.name = input.name;
    const metadata = metadataToForm(input.metadata);
    if (metadata) body.metadata = metadata;
    const customer = (await this.request<StripeCustomer>("POST", "/customers", body))!;
    return mapCustomer(customer);
  }

  async getCustomer(id: string): Promise<BillingCustomer | null> {
    const customer = await this.request<StripeCustomer & { deleted?: boolean }>(
      "GET",
      `/customers/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (!customer || customer.deleted) return null;
    return mapCustomer(customer);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const body: FormObject = {
      mode: input.mode,
      success_url: input.successUrl,
      line_items: input.items.map((item) => ({
        price: item.priceId,
        quantity: item.quantity ?? 1,
      })),
    };
    if (input.cancelUrl) body.cancel_url = input.cancelUrl;
    if (input.customerId) body.customer = input.customerId;
    else if (input.customerEmail) body.customer_email = input.customerEmail;
    const metadata = metadataToForm(input.metadata);
    if (metadata) body.metadata = metadata;
    if (input.mode === "subscription" && input.trialDays !== undefined) {
      body.subscription_data = { trial_period_days: input.trialDays };
    }
    const session = (await this.request<{ id: string; url: string }>(
      "POST",
      "/checkout/sessions",
      body
    ))!;
    return { id: session.id, url: session.url, provider: "stripe" };
  }

  async getSubscription(id: string): Promise<BillingSubscription | null> {
    const sub = await this.request<StripeSubscription>(
      "GET",
      `/subscriptions/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    return sub ? mapSubscription(sub) : null;
  }

  async listSubscriptions(customerId: string): Promise<BillingSubscription[]> {
    const list = (await this.request<StripeList<StripeSubscription>>(
      "GET",
      `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all`
    ))!;
    return (list.data ?? []).map(mapSubscription);
  }

  async cancelSubscription(
    id: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    if (options?.atPeriodEnd) {
      const sub = (await this.request<StripeSubscription>(
        "POST",
        `/subscriptions/${encodeURIComponent(id)}`,
        { cancel_at_period_end: true }
      ))!;
      return mapSubscription(sub);
    }
    const sub = (await this.request<StripeSubscription>(
      "DELETE",
      `/subscriptions/${encodeURIComponent(id)}`
    ))!;
    return mapSubscription(sub);
  }

  async updateSubscription(
    id: string,
    update: { priceId?: string; quantity?: number; cancelAtPeriodEnd?: boolean }
  ): Promise<BillingSubscription> {
    const body: FormObject = {};
    if (update.priceId !== undefined || update.quantity !== undefined) {
      const item: FormObject = {};
      if (update.priceId !== undefined) item.price = update.priceId;
      if (update.quantity !== undefined) item.quantity = update.quantity;
      body.items = [item];
    }
    if (update.cancelAtPeriodEnd !== undefined) {
      body.cancel_at_period_end = update.cancelAtPeriodEnd;
    }
    const sub = (await this.request<StripeSubscription>(
      "POST",
      `/subscriptions/${encodeURIComponent(id)}`,
      body
    ))!;
    return mapSubscription(sub);
  }

  async reportUsage(input: ReportUsageInput): Promise<void> {
    const body: FormObject = {
      quantity: input.quantity,
      action: input.action ?? "increment",
    };
    if (input.timestamp) {
      body.timestamp = Math.floor(input.timestamp.getTime() / 1000);
    }
    await this.request(
      "POST",
      `/subscription_items/${encodeURIComponent(input.subscriptionItemId)}/usage_records`,
      body
    );
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<PortalSession> {
    const session = (await this.request<{ url: string }>("POST", "/billing_portal/sessions", {
      customer: customerId,
      return_url: returnUrl,
    }))!;
    return { url: session.url };
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    const header = headers["stripe-signature"] ?? headers["Stripe-Signature"];
    if (!header) return false;

    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const [key, value] = part.split("=");
      if (key === "t") timestamp = value;
      else if (key === "v1" && value) signatures.push(value);
    }
    if (!timestamp || signatures.length === 0) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false;

    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");

    return signatures.some((sig) => {
      let sigBuf: Buffer;
      try {
        sigBuf = Buffer.from(sig, "hex");
      } catch {
        return false;
      }
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
  }

  parseWebhookEvent(payload: string, _headers: Record<string, string>): BillingEvent | null {
    let parsed: {
      id?: string;
      type?: string;
      data?: { object?: unknown };
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.type !== "string") return null;

    const type = mapEventType(parsed.type);
    const object = parsed.data?.object as Record<string, unknown> | undefined;

    const event: BillingEvent = {
      id: parsed.id ?? "",
      type,
      provider: "stripe",
      raw: parsed,
    };

    if (!object) return event;

    if (parsed.type.startsWith("customer.subscription.")) {
      const sub = object as unknown as StripeSubscription;
      event.subscription = mapSubscription(sub);
      event.customerId = sub.customer;
      event.metadata = sub.metadata;
    } else if (parsed.type.startsWith("invoice.")) {
      const invoice = object as unknown as StripeInvoice;
      event.customerId = invoice.customer;
      event.amount = invoice.amount_paid ?? invoice.total ?? invoice.amount_due;
      event.currency = invoice.currency;
      event.metadata = invoice.metadata;
      const priceId = invoice.lines?.data?.[0]?.price?.id;
      if (priceId) {
        event.subscription = {
          id: typeof invoice.subscription === "string" ? invoice.subscription : "",
          customerId: invoice.customer ?? "",
          status: "active",
          priceId,
          metadata: invoice.metadata,
          provider: "stripe",
        };
      }
    } else if (parsed.type === "checkout.session.completed") {
      const session = object as unknown as StripeCheckoutSessionObject;
      event.customerId = session.customer;
      event.amount = session.amount_total;
      event.currency = session.currency;
      event.metadata = session.metadata;
      if (session.subscription && typeof session.subscription === "object") {
        event.subscription = mapSubscription(session.subscription);
      }
    } else {
      const meta = (object as { metadata?: Record<string, string> }).metadata;
      if (meta) event.metadata = meta;
    }

    return event;
  }
}

export const createStripeAdapter = (config: StripeAdapterConfig): BillingAdapter =>
  new StripeBillingAdapter(config);
