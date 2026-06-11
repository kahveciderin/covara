import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { createCreditsLedger } from "@/billing/credits";
import { createBilling } from "@/billing";
import type {
  BillingAdapter,
  BillingEvent,
  BillingSubscription,
} from "@/billing/types";

describe("Credits ledger", () => {
  let kv: KVAdapter;
  beforeEach(async () => {
    kv = createMemoryKV(`credits-${Date.now()}-${Math.random()}`);
    await kv.connect();
    setGlobalKV(kv);
  });
  afterEach(async () => {
    await kv.disconnect();
  });

  it("grants, consumes, and tracks balance + history", async () => {
    const ledger = createCreditsLedger();
    expect(await ledger.balance("acct")).toBe(0);

    expect(await ledger.grant("acct", 100, { reason: "signup" })).toBe(100);
    const consume = await ledger.consume("acct", 30, { reason: "api-call" });
    expect(consume.ok).toBe(true);
    expect(consume.balance).toBe(70);
    expect(await ledger.balance("acct")).toBe(70);

    const history = await ledger.history("acct");
    expect(history).toHaveLength(2);
    expect(history[0].delta).toBe(-30); // most recent first
    expect(history[1].delta).toBe(100);
  });

  it("refuses to overdraw unless allowNegative", async () => {
    const ledger = createCreditsLedger();
    await ledger.grant("acct", 10);
    const res = await ledger.consume("acct", 50);
    expect(res.ok).toBe(false);
    expect(res.balance).toBe(10);
    expect(await ledger.balance("acct")).toBe(10);
  });
});

// A minimal in-memory billing adapter to validate the facade's plan resolution,
// webhook dedup, and credit auto-grant without hitting a real provider.
const makeMockAdapter = (event: BillingEvent): BillingAdapter => ({
  provider: "stripe",
  async createCustomer(input) {
    return { id: "cus_1", email: input.email, provider: "stripe" };
  },
  async getCustomer() {
    return null;
  },
  async createCheckout(input) {
    return { id: "cs_1", url: `https://pay.test/${input.items[0].priceId}`, provider: "stripe" };
  },
  async getSubscription() {
    return null;
  },
  async listSubscriptions() {
    return [];
  },
  async cancelSubscription(id) {
    return { id, customerId: "cus_1", status: "canceled", provider: "stripe" } as BillingSubscription;
  },
  async updateSubscription(id) {
    return { id, customerId: "cus_1", status: "active", provider: "stripe" } as BillingSubscription;
  },
  async reportUsage() {},
  verifyWebhook() {
    return true;
  },
  parseWebhookEvent() {
    return event;
  },
});

describe("Billing facade", () => {
  let kv: KVAdapter;
  beforeEach(async () => {
    kv = createMemoryKV(`billing-${Date.now()}-${Math.random()}`);
    await kv.connect();
    setGlobalKV(kv);
  });
  afterEach(async () => {
    await kv.disconnect();
  });

  it("resolves a plan key to a checkout", async () => {
    const billing = createBilling({
      adapter: makeMockAdapter({} as BillingEvent),
      plans: [{ key: "pro", priceId: "price_pro", type: "subscription", credits: 1000 }],
    });
    const session = await billing.checkoutPlan("pro", { successUrl: "https://app.test/ok", customerEmail: "a@b.c" });
    expect(session.url).toContain("price_pro");
  });

  it("auto-grants credits on payment.succeeded and dedupes retries", async () => {
    const event: BillingEvent = {
      id: "evt_1",
      type: "payment.succeeded",
      provider: "stripe",
      customerId: "cus_1",
      subscription: {
        id: "sub_1",
        customerId: "cus_1",
        status: "active",
        priceId: "price_pro",
        metadata: { accountId: "acct-42" },
        provider: "stripe",
      },
      raw: {},
    };
    const billing = createBilling({
      adapter: makeMockAdapter(event),
      plans: [{ key: "pro", priceId: "price_pro", credits: 1000 }],
      webhookSecret: "whsec",
    });

    const result = await billing.handleWebhook("{}", {});
    expect(result?.planKey).toBe("pro");
    expect(result?.creditsToGrant).toBe(1000);
    expect(await billing.credits.balance("acct-42")).toBe(1000);

    // Retried delivery (same event id) must NOT grant again.
    await billing.handleWebhook("{}", {});
    expect(await billing.credits.balance("acct-42")).toBe(1000);
  });

  it("rejects an invalid webhook signature", async () => {
    const adapter = makeMockAdapter({} as BillingEvent);
    adapter.verifyWebhook = () => false;
    const billing = createBilling({ adapter, webhookSecret: "whsec" });
    await expect(billing.handleWebhook("{}", {})).rejects.toThrow(/signature/i);
  });
});
