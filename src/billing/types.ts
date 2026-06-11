export type BillingProviderName = "stripe" | "lemonsqueezy" | "paddle" | "polar";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "paused"
  | "incomplete"
  | "expired"
  | "unpaid";

export interface BillingCustomer {
  id: string;
  email?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  provider: BillingProviderName;
}

export interface BillingSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  // The provider price/variant id the subscription is on.
  priceId?: string;
  productId?: string;
  quantity?: number;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: Date;
  metadata?: Record<string, unknown>;
  provider: BillingProviderName;
}

export interface CheckoutSession {
  id: string;
  url: string;
  provider: BillingProviderName;
}

export interface PortalSession {
  url: string;
}

export type CheckoutMode = "subscription" | "payment";

export interface CheckoutItem {
  // Provider price / variant / product id (see each adapter's docs).
  priceId: string;
  quantity?: number;
}

export interface CreateCheckoutInput {
  mode: CheckoutMode;
  items: CheckoutItem[];
  customerId?: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl?: string;
  // Free-form metadata persisted on the resulting subscription/order so
  // webhooks can correlate back to your user/account.
  metadata?: Record<string, unknown>;
  // Quantity-less usage-based subscriptions, free trials, etc.
  trialDays?: number;
}

export interface CreateCustomerInput {
  email: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface ReportUsageInput {
  // Provider-specific usage handle (subscription item id, meter id, etc.).
  subscriptionItemId: string;
  quantity: number;
  timestamp?: Date;
  action?: "increment" | "set";
}

export type BillingEventType =
  | "checkout.completed"
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "payment.succeeded"
  | "payment.failed"
  | "unknown";

export interface BillingEvent {
  id: string;
  type: BillingEventType;
  provider: BillingProviderName;
  customerId?: string;
  subscription?: BillingSubscription;
  // Friendly plan key resolved from configured plans (set by the facade), when
  // the event references a known price id.
  planKey?: string;
  // Credits to grant for this event, resolved from plan config by the facade.
  creditsToGrant?: number;
  metadata?: Record<string, unknown>;
  amount?: number;
  currency?: string;
  raw: unknown;
}

export interface BillingAdapter {
  readonly provider: BillingProviderName;

  createCustomer(input: CreateCustomerInput): Promise<BillingCustomer>;
  getCustomer(id: string): Promise<BillingCustomer | null>;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;

  getSubscription(id: string): Promise<BillingSubscription | null>;
  listSubscriptions(customerId: string): Promise<BillingSubscription[]>;
  cancelSubscription(
    id: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<BillingSubscription>;
  updateSubscription(
    id: string,
    update: { priceId?: string; quantity?: number; cancelAtPeriodEnd?: boolean }
  ): Promise<BillingSubscription>;

  // Usage-based billing; adapters that don't support it throw a clear error.
  reportUsage(input: ReportUsageInput): Promise<void>;

  // Hosted billing portal (where the provider offers one).
  createPortalSession?(customerId: string, returnUrl: string): Promise<PortalSession>;

  // Webhooks
  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean;
  parseWebhookEvent(payload: string, headers: Record<string, string>): BillingEvent | null;
}

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly provider?: BillingProviderName,
    public readonly status?: number
  ) {
    super(message);
    this.name = "BillingError";
  }
}
