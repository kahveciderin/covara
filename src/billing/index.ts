import type { Context } from "hono";
import { getGlobalKV, hasGlobalKV } from "@/kv";
import { getLogger } from "@/server/logger";
import {
  BillingAdapter,
  BillingError,
  BillingEvent,
  BillingSubscription,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  PortalSession,
  ReportUsageInput,
} from "./types";
import { createCreditsLedger, CreditsLedger } from "./credits";
import {
  createKVSubscriptionStore,
  type BillingSubscriptionStore,
  type StoredSubscription,
} from "./subscription-store";
import {
  createReconciler,
  type BillingReconcileReport,
  type ReconcileAllOptions,
  type ReconcileOptions,
} from "./reconcile";

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
  // Defaults to the non-durable KV ledger for back-compat; pass
  // createDrizzleCreditsLedger({ db }) for a durable system of record.
  credits?: CreditsLedger;
  // Local mirror of provider subscription state used by reconciliation.
  // Defaults to a KV-backed store when a global KV is configured; pass
  // createDrizzleSubscriptionStore({ db }) for durability, or false to disable.
  subscriptions?: BillingSubscriptionStore | false;
  webhookSecret?: string;
  // Grant `plan.credits` automatically on payment.succeeded. Default true when a
  // credits ledger is available.
  autoGrantCredits?: boolean;
  // Resolve which credits account an event belongs to. Defaults to the
  // subscription/checkout metadata's accountId|userId|customerId.
  resolveAccount?: (event: BillingEvent) => string | undefined;
  onEvent?: (event: BillingEvent) => void | Promise<void>;
  // How long an in-progress delivery blocks duplicates before a crashed
  // handler's claim lapses and a retry may run it. Default 5 minutes.
  webhookLeaseMs?: number;
}

export interface Billing {
  readonly adapter: BillingAdapter;
  readonly credits: CreditsLedger;
  readonly subscriptions: BillingSubscriptionStore | null;
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
  reconcile(input: { customerId: string } & ReconcileOptions): Promise<BillingReconcileReport>;
  reconcileAll(options?: ReconcileAllOptions): Promise<BillingReconcileReport>;
}

export class BillingWebhookSignatureError extends BillingError {
  constructor(provider: BillingAdapter["provider"]) {
    super("Invalid billing webhook signature", provider, 400);
    this.name = "BillingWebhookSignatureError";
  }
}

export class BillingWebhookInFlightError extends BillingError {
  constructor(
    provider: BillingAdapter["provider"],
    public readonly eventId: string
  ) {
    super(`Billing webhook ${eventId} is already being processed`, provider, 409);
    this.name = "BillingWebhookInFlightError";
  }
}

const defaultResolveAccount = (event: BillingEvent): string | undefined => {
  const meta = (event.subscription?.metadata ?? event.metadata ?? {}) as Record<string, unknown>;
  const candidate = meta.accountId ?? meta.userId ?? meta.account_id ?? meta.user_id;
  if (typeof candidate === "string") return candidate;
  return event.customerId;
};

const DEDUP_PREFIX = "covara:billing:evt:";
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const PROCESSING_PREFIX = "processing:";

type EventClaim =
  | { state: "claimed"; complete(): Promise<void>; release(): Promise<void> }
  | { state: "done" }
  | { state: "in_flight" };

export const createBilling = (config: BillingConfig): Billing => {
  const adapter = config.adapter;
  const credits = config.credits ?? createCreditsLedger();
  const plansByKey = new Map((config.plans ?? []).map((p) => [p.key, p]));
  const plansByPrice = new Map((config.plans ?? []).map((p) => [p.priceId, p]));
  const resolveAccount = config.resolveAccount ?? defaultResolveAccount;
  const autoGrant = config.autoGrantCredits !== false;
  const leaseMs = config.webhookLeaseMs ?? DEFAULT_LEASE_MS;

  let kvStore: BillingSubscriptionStore | null = null;
  const resolveStore = (): BillingSubscriptionStore | null => {
    if (config.subscriptions === false) return null;
    if (config.subscriptions) return config.subscriptions;
    if (!hasGlobalKV()) return null;
    kvStore ??= createKVSubscriptionStore();
    return kvStore;
  };

  const enrich = (event: BillingEvent): BillingEvent => {
    const priceId = event.subscription?.priceId ?? (event.metadata?.priceId as string | undefined);
    const plan = priceId ? plansByPrice.get(priceId) : undefined;
    if (plan) {
      event.planKey = plan.key;
      event.creditsToGrant = plan.credits;
    }
    return event;
  };

  // A delivery is marked done only after every side effect succeeded. While it
  // runs it holds a lease so concurrent duplicates back off (409) instead of
  // running twice; a failure releases the claim so the provider's retry is
  // processed rather than swallowed.
  const claimEvent = async (eventId: string, attempt = 0): Promise<EventClaim> => {
    const noop = async (): Promise<void> => {};
    if (!eventId || !hasGlobalKV()) return { state: "claimed", complete: noop, release: noop };
    const kv = getGlobalKV();
    const key = `${DEDUP_PREFIX}${eventId}`;
    const token = `${PROCESSING_PREFIX}${crypto.randomUUID()}`;
    await kv.set(key, token, { nx: true, px: leaseMs });
    const current = await kv.get(key);
    if (current === token) {
      return {
        state: "claimed",
        complete: async () => {
          await kv.set(key, "done", { px: DEDUP_TTL_MS });
        },
        release: async () => {
          if ((await kv.get(key)) === token) await kv.del(key);
        },
      };
    }
    if (current === null) {
      return attempt < 3 ? claimEvent(eventId, attempt + 1) : { state: "in_flight" };
    }
    return current.startsWith(PROCESSING_PREFIX) ? { state: "in_flight" } : { state: "done" };
  };

  const persistSubscription = async (event: BillingEvent): Promise<void> => {
    const sub = event.subscription;
    if (!sub?.id || !event.type.startsWith("subscription.")) return;
    const store = resolveStore();
    if (!store) return;
    const record: StoredSubscription = {
      subscription: sub,
      account: resolveAccount(event),
      updatedAt: Date.now(),
      source: event.source ?? "webhook",
    };
    await store.put(record);
  };

  // The single pipeline shared by webhooks and reconciliation, so app hooks
  // observe both identically. Local state is written last: if a hook throws,
  // the next delivery or reconcile run still sees the drift and retries.
  const processEvent = async (event: BillingEvent): Promise<void> => {
    enrich(event);

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
          idempotencyKey: event.id ? `billing:${event.provider}:${event.id}` : undefined,
        });
      }
    }

    if (config.onEvent) {
      await config.onEvent(event);
    }

    await persistSubscription(event);
  };

  const runClaimed = async (
    event: BillingEvent
  ): Promise<"applied" | "already_applied" | "in_flight"> => {
    const claim = await claimEvent(event.id);
    if (claim.state === "done") return "already_applied";
    if (claim.state === "in_flight") return "in_flight";
    try {
      await processEvent(event);
    } catch (err) {
      await claim.release();
      throw err;
    }
    await claim.complete();
    return "applied";
  };

  const handleWebhook = async (
    payload: string,
    headers: Record<string, string>
  ): Promise<BillingEvent | null> => {
    if (config.webhookSecret && !adapter.verifyWebhook(payload, headers, config.webhookSecret)) {
      throw new BillingWebhookSignatureError(adapter.provider);
    }
    const parsed = adapter.parseWebhookEvent(payload, headers);
    if (!parsed) return null;

    const result = await runClaimed(parsed);
    if (result === "in_flight") throw new BillingWebhookInFlightError(adapter.provider, parsed.id);
    return parsed;
  };

  const reconciler = createReconciler({
    adapter,
    store: resolveStore,
    apply: runClaimed,
    persist: persistSubscription,
  });

  return {
    adapter,
    credits,
    get subscriptions() {
      return resolveStore();
    },
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
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof BillingWebhookSignatureError) {
            getLogger().warn("Billing webhook rejected", { provider: adapter.provider, error: message });
            return c.json({ error: "Webhook verification failed" }, 400);
          }
          if (err instanceof BillingWebhookInFlightError) {
            return c.json({ error: "Webhook already being processed" }, 409);
          }
          getLogger().error("Billing webhook handler failed", {
            provider: adapter.provider,
            error: message,
          });
          return c.json({ error: "Webhook processing failed" }, 500);
        }
      };
    },
    reconcile: (input) => reconciler.reconcile(input),
    reconcileAll: (options) => reconciler.reconcileAll(options),
  };
};

export * from "./types";
export * from "./credits";
export * from "./subscription-store";
export * from "./reconcile";
export * from "./reconcile-task";
export * from "./stripe";
export * from "./lemonsqueezy";
export * from "./paddle";
export * from "./polar";
export * from "./router";
