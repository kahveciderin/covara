import { Transport } from "./transport";

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

export interface BillingSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId?: string;
  productId?: string;
  quantity?: number;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: string;
  metadata?: Record<string, unknown>;
  provider: BillingProviderName;
}

export type CheckoutMode = "subscription" | "payment";

export interface CheckoutItem {
  priceId: string;
  quantity?: number;
}

export interface CheckoutInput {
  plan?: string;
  items?: CheckoutItem[];
  mode?: CheckoutMode;
  quantity?: number;
  successUrl: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
  trialDays?: number;
}

export interface CheckoutResult {
  id: string;
  url: string;
}

export interface PortalResult {
  url: string;
}

export interface BillingClient {
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  redirectToCheckout(input: CheckoutInput): Promise<void>;
  getSubscription(): Promise<BillingSubscription[]>;
  getCredits(): Promise<number>;
  openPortal(returnUrl: string): Promise<PortalResult>;
  redirectToPortal(returnUrl: string): Promise<void>;
}

export interface BillingClientConfig {
  transport: Transport;
  basePath?: string;
}

const isActive = (status: SubscriptionStatus): boolean =>
  status === "active" || status === "trialing";

export const isActiveSubscription = (
  subscription: BillingSubscription
): boolean => isActive(subscription.status);

export const createBillingClient = (
  config: BillingClientConfig
): BillingClient => {
  const { transport } = config;
  const basePath = (config.basePath ?? "/api/billing").replace(/\/$/, "");

  const redirect = (url: string): void => {
    if (typeof window !== "undefined" && window.location) {
      window.location.href = url;
    }
  };

  const checkout = async (input: CheckoutInput): Promise<CheckoutResult> => {
    const { data } = await transport.request<CheckoutResult>({
      method: "POST",
      path: `${basePath}/checkout`,
      body: input,
    });
    return data;
  };

  const redirectToCheckout = async (input: CheckoutInput): Promise<void> => {
    const { url } = await checkout(input);
    redirect(url);
  };

  const getSubscription = async (): Promise<BillingSubscription[]> => {
    const { data } = await transport.request<{
      subscriptions: BillingSubscription[];
    }>({
      method: "GET",
      path: `${basePath}/subscription`,
    });
    return data.subscriptions ?? [];
  };

  const getCredits = async (): Promise<number> => {
    const { data } = await transport.request<{ balance: number }>({
      method: "GET",
      path: `${basePath}/credits`,
    });
    return data.balance;
  };

  const openPortal = async (returnUrl: string): Promise<PortalResult> => {
    const { data } = await transport.request<PortalResult>({
      method: "POST",
      path: `${basePath}/portal`,
      body: { returnUrl },
    });
    return data;
  };

  const redirectToPortal = async (returnUrl: string): Promise<void> => {
    const { url } = await openPortal(returnUrl);
    redirect(url);
  };

  return {
    checkout,
    redirectToCheckout,
    getSubscription,
    getCredits,
    openPortal,
    redirectToPortal,
  };
};
