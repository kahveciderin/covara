import type { Context } from "hono";
import { getGlobalKV, hasGlobalKV } from "@/kv";
import { getLogger } from "@/server/logger";
import {
  BillingAdapter,
  BillingEvent,
  BillingSubscription,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  PortalSession,
  ReportUsageInput,
} from "./types";
import { createCreditsLedger, CreditsLedger } from "./credits";

let globalBillingAdapter: BillingAdapter | null = null;

export const setGlobalBilling = (adapter: BillingAdapter): void => {
  globalBillingAdapter = adapter;
};

export const getGlobalBilling = (): BillingAdapter => {
  if (!globalBillingAdapter) {
    throw new Error("No global billing adapter configured. Call setGlobalBilling() first.");
  }
  return globalBillingAdapter;
};

export const hasGlobalBilling = (): boolean => globalBillingAdapter !== null;

export const clearGlobalBilling = (): void => {
  globalBillingAdapter = null;
};

export interface BillingPlan {
  // Your stable key, e.g. "pro_monthly". Referenced by checkout helpers.
  key: string;
  // Provider price / variant / product id.
  priceId: string;
  name?: string;
  type?: "subscription" | "one_time" | "usage";
  // Credits granted to the account when a payment for this plan succeeds.
  credits?: number;
  interval?: "month" | "year";
  metadata?: Record<string, unknown>;
}

export interface BillingConfig {
  adapter: BillingAdapter;
  plans?: BillingPlan[];
  credits?: CreditsLedger;
  webhookSecret?: string;
  // Grant `plan.credits` automatically on payment.succeeded. Default true when a
  // credits ledger is available.
  autoGrantCredits?: boolean;
  // Resolve which credits account an event belongs to. Defaults to the
  // subscription/checkout metadata's accountId|userId|customerId.
  resolveAccount?: (event: BillingEvent) => string | undefined;
  onEvent?: (event: BillingEvent) => void | Promise<void>;
}

export interface Billing {
  readonly adapter: BillingAdapter;
  readonly credits: CreditsLedger;
  plan(key: string): BillingPlan | undefined;
  createCustomer(input: CreateCustomerInput): ReturnType<BillingAdapter["createCustomer"]>;
  checkout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  checkoutPlan(
    planKey: string,
    opts: Omit<CreateCheckoutInput, "items" | "mode"> & { quantity?: number; mode?: CreateCheckoutInput["mode"] }
  ): Promise<CheckoutSession>;
  getSubscription(id: string): Promise<BillingSubscription | null>;
  cancelSubscription(id: string, options?: { atPeriodEnd?: boolean }): Promise<BillingSubscription>;
  reportUsage(input: ReportUsageInput): Promise<void>;
  portal(customerId: string, returnUrl: string): Promise<PortalSession>;
  handleWebhook(payload: string, headers: Record<string, string>): Promise<BillingEvent | null>;
  webhookHandler(): (c: Context) => Promise<Response>;
}

const defaultResolveAccount = (event: BillingEvent): string | undefined => {
  const meta = (event.subscription?.metadata ?? event.metadata ?? {}) as Record<string, unknown>;
  const candidate = meta.accountId ?? meta.userId ?? meta.account_id ?? meta.user_id;
  if (typeof candidate === "string") return candidate;
  return event.customerId;
};

const DEDUP_PREFIX = "concave:billing:evt:";
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export const createBilling = (config: BillingConfig): Billing => {
  const adapter = config.adapter;
  const credits = config.credits ?? createCreditsLedger();
  const plansByKey = new Map((config.plans ?? []).map((p) => [p.key, p]));
  const plansByPrice = new Map((config.plans ?? []).map((p) => [p.priceId, p]));
  const resolveAccount = config.resolveAccount ?? defaultResolveAccount;
  const autoGrant = config.autoGrantCredits !== false;

  const enrich = (event: BillingEvent): BillingEvent => {
    const priceId = event.subscription?.priceId ?? (event.metadata?.priceId as string | undefined);
    const plan = priceId ? plansByPrice.get(priceId) : undefined;
    if (plan) {
      event.planKey = plan.key;
      event.creditsToGrant = plan.credits;
    }
    return event;
  };

  // De-duplicate webhook deliveries (providers retry): returns true if this is
  // the first time we've seen the event id.
  const markSeen = async (eventId: string): Promise<boolean> => {
    if (!hasGlobalKV()) return true;
    const kv = getGlobalKV();
    const key = `${DEDUP_PREFIX}${eventId}`;
    if (await kv.get(key)) return false;
    await kv.set(key, "1", { px: DEDUP_TTL_MS });
    return true;
  };

  const handleWebhook = async (
    payload: string,
    headers: Record<string, string>
  ): Promise<BillingEvent | null> => {
    if (config.webhookSecret && !adapter.verifyWebhook(payload, headers, config.webhookSecret)) {
      throw new Error("Invalid billing webhook signature");
    }
    const parsed = adapter.parseWebhookEvent(payload, headers);
    if (!parsed) return null;

    const fresh = await markSeen(parsed.id);
    if (!fresh) return parsed;

    const event = enrich(parsed);

    if (
      autoGrant &&
      event.type === "payment.succeeded" &&
      event.creditsToGrant &&
      event.creditsToGrant > 0
    ) {
      const account = resolveAccount(event);
      if (account) {
        await credits.grant(account, event.creditsToGrant, {
          reason: `billing:${event.planKey ?? "payment"}`,
          metadata: { eventId: event.id, provider: event.provider },
        });
      }
    }

    if (config.onEvent) {
      await config.onEvent(event);
    }
    return event;
  };

  return {
    adapter,
    credits,
    plan: (key) => plansByKey.get(key),
    createCustomer: (input) => adapter.createCustomer(input),
    checkout: (input) => adapter.createCheckout(input),
    checkoutPlan: (planKey, opts) => {
      const plan = plansByKey.get(planKey);
      if (!plan) throw new Error(`Unknown billing plan: ${planKey}`);
      const mode = opts.mode ?? (plan.type === "one_time" ? "payment" : "subscription");
      return adapter.createCheckout({
        ...opts,
        mode,
        items: [{ priceId: plan.priceId, quantity: opts.quantity }],
      });
    },
    getSubscription: (id) => adapter.getSubscription(id),
    cancelSubscription: (id, options) => adapter.cancelSubscription(id, options),
    reportUsage: (input) => adapter.reportUsage(input),
    portal: (customerId, returnUrl) => {
      if (!adapter.createPortalSession) {
        throw new Error(`${adapter.provider} does not support a billing portal`);
      }
      return adapter.createPortalSession(customerId, returnUrl);
    },
    handleWebhook,
    webhookHandler() {
      return async (c: Context): Promise<Response> => {
        const payload = await c.req.text();
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        try {
          await handleWebhook(payload, headers);
          return c.json({ received: true });
        } catch (err) {
          getLogger().warn("Billing webhook rejected", {
            provider: adapter.provider,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: "Webhook verification failed" }, 400);
        }
      };
    },
  };
};

export * from "./types";
export * from "./credits";
export * from "./stripe";
export * from "./lemonsqueezy";
export * from "./paddle";
export * from "./polar";
export * from "./router";
