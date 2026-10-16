import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { migrateInternal } from "@/db/migrate";
import {
  createBilling,
  createBillingRouter,
  createBillingReconcileTask,
  createKVSubscriptionStore,
  createDrizzleSubscriptionStore,
  type Billing,
  type BillingSubscriptionStore,
} from "@/billing";
import { BillingError } from "@/billing/types";
import type {
  BillingAdapter,
  BillingEvent,
  BillingSubscription,
  SubscriptionPage,
} from "@/billing/types";

interface MockAdapter extends BillingAdapter {
  remote: Map<string, BillingSubscription>;
  failList: Array<Error>;
  failGet: Array<Error>;
  failListAll: Array<Error>;
  onList?: () => Promise<void> | void;
  calls: { list: number; get: number; listAll: number };
}

const sub = (id: string, customerId: string, extra: Partial<BillingSubscription> = {}): BillingSubscription => ({
  id,
  customerId,
  status: "active",
  priceId: "price_pro",
  provider: "stripe",
  metadata: { accountId: `acct-${customerId}` },
  ...extra,
});

const makeAdapter = (supportsListAll = true): MockAdapter => {
  const adapter: MockAdapter = {
    provider: "stripe",
    remote: new Map(),
    failList: [],
    failGet: [],
    failListAll: [],
    calls: { list: 0, get: 0, listAll: 0 },
    async createCustomer(input) {
      return { id: "cus_x", email: input.email, provider: "stripe" };
    },
    async getCustomer() {
      return null;
    },
    async createCheckout() {
      return { id: "cs", url: "https://pay.test", provider: "stripe" };
    },
    async getSubscription(id) {
      adapter.calls.get++;
      const failure = adapter.failGet.shift();
      if (failure) throw failure;
      const found = adapter.remote.get(id);
      return found ? { ...found } : null;
    },
    async listSubscriptions(customerId) {
      adapter.calls.list++;
      const failure = adapter.failList.shift();
      if (failure) throw failure;
      await adapter.onList?.();
      return [...adapter.remote.values()].filter((s) => s.customerId === customerId).map((s) => ({ ...s }));
    },
    async cancelSubscription(id) {
      return sub(id, "x", { status: "canceled" });
    },
    async updateSubscription(id) {
      return sub(id, "x");
    },
    async reportUsage() {},
    verifyWebhook() {
      return true;
    },
    parseWebhookEvent(payload) {
      return JSON.parse(payload) as BillingEvent;
    },
  };
  if (supportsListAll) {
    adapter.listAllSubscriptions = async (options): Promise<SubscriptionPage> => {
      adapter.calls.listAll++;
      const failure = adapter.failListAll.shift();
      if (failure) throw failure;
      const all = [...adapter.remote.values()].sort((a, b) => a.id.localeCompare(b.id));
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = all.slice(start, start + 2);
      return {
        subscriptions: page.map((s) => ({ ...s })),
        nextCursor: start + 2 < all.length ? String(start + 2) : undefined,
      };
    };
  }
  return adapter;
};

const subscriptionEvent = (
  type: BillingEvent["type"],
  subscription: BillingSubscription,
  id = `evt_${Math.random()}`
): string =>
  JSON.stringify({
    id,
    type,
    provider: "stripe",
    customerId: subscription.customerId,
    subscription,
    raw: {},
  });

const retryFast = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

interface StoreBackend {
  name: string;
  make(): Promise<{ store: BillingSubscriptionStore; teardown(): Promise<void> }>;
}

const storeBackends: StoreBackend[] = [
  {
    name: "kv",
    async make() {
      return { store: createKVSubscriptionStore(), teardown: async () => {} };
    },
  },
  {
    name: "drizzle better-sqlite3",
    async make() {
      const sqlite = new Database(":memory:");
      const db = drizzleBetterSqlite(sqlite);
      await migrateInternal(db);
      return { store: createDrizzleSubscriptionStore({ db }), teardown: async () => sqlite.close() };
    },
  },
  {
    name: "drizzle pglite",
    async make() {
      const pglite = new PGlite();
      const db = drizzlePglite(pglite);
      await migrateInternal(db);
      return { store: createDrizzleSubscriptionStore({ db }), teardown: () => pglite.close() };
    },
  },
];

let kv: KVAdapter;
beforeEach(async () => {
  kv = createMemoryKV(`reconcile-${Date.now()}-${Math.random()}`);
  await kv.connect();
  setGlobalKV(kv);
});
afterEach(async () => {
  await kv.disconnect();
});

for (const backend of storeBackends) {
  describe(`Subscription store — ${backend.name}`, () => {
    it("round-trips a subscription with dates, metadata and account", async () => {
      const { store, teardown } = await backend.make();
      const record = {
        subscription: sub("sub_1", "cus_1", {
          quantity: 2,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: new Date("2026-02-01T00:00:00.123Z"),
        }),
        account: "acct-1",
        updatedAt: 1234,
        source: "webhook" as const,
      };
      await store.put(record);
      const loaded = await store.get("sub_1");
      expect(loaded?.subscription).toEqual(record.subscription);
      expect(loaded?.account).toBe("acct-1");
      expect(loaded?.updatedAt).toBe(1234);

      await store.put({ ...record, subscription: { ...record.subscription, status: "past_due" }, updatedAt: 2000 });
      expect((await store.get("sub_1"))?.subscription.status).toBe("past_due");
      expect(await store.listByCustomer("cus_1")).toHaveLength(1);
      expect(await store.listCustomers()).toEqual(["cus_1"]);
      expect(await store.get("missing")).toBeNull();
      await teardown();
    });
  });
}

describe("Webhook path persists subscription state and fails safely", () => {
  it("stores state from subscription.* events but not from synthesized payment events", async () => {
    const adapter = makeAdapter();
    const billing = createBilling({ adapter });
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    await billing.handleWebhook(
      subscriptionEvent("payment.succeeded", sub("sub_2", "cus_1")),
      {}
    );
    const local = await billing.subscriptions!.listByCustomer("cus_1");
    expect(local.map((r) => r.subscription.id)).toEqual(["sub_1"]);
    expect(local[0].account).toBe("acct-cus_1");
  });

  it("does not mark an event seen when a handler throws, so the retry re-runs it", async () => {
    let attempts = 0;
    const billing = createBilling({
      adapter: makeAdapter(),
      plans: [{ key: "pro", priceId: "price_pro", credits: 100 }],
      onEvent: async () => {
        attempts++;
        if (attempts === 1) throw new Error("downstream outage");
      },
    });
    const payload = subscriptionEvent("payment.succeeded", sub("sub_1", "cus_1"), "evt_fail");
    await expect(billing.handleWebhook(payload, {})).rejects.toThrow("downstream outage");
    await billing.handleWebhook(payload, {});
    expect(attempts).toBe(2);
    await billing.handleWebhook(payload, {});
    expect(attempts).toBe(2);
    expect(await billing.credits.balance("acct-cus_1")).toBe(100);
  });

  it("the auto-grant is idempotent per provider event id even if the dedupe record is lost", async () => {
    const billing = createBilling({
      adapter: makeAdapter(),
      plans: [{ key: "pro", priceId: "price_pro", credits: 100 }],
    });
    const payload = subscriptionEvent("payment.succeeded", sub("sub_1", "cus_1"), "evt_once");
    await billing.handleWebhook(payload, {});
    await kv.del("covara:billing:evt:evt_once");
    await billing.handleWebhook(payload, {});
    expect(await billing.credits.balance("acct-cus_1")).toBe(100);
    const [entry] = await billing.credits.history("acct-cus_1");
    expect(entry.idempotencyKey).toBe("billing:stripe:evt_once");
  });

  it("concurrent duplicate deliveries run hooks once", async () => {
    const onEvent = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const billing = createBilling({ adapter: makeAdapter(), onEvent });
    const payload = subscriptionEvent("subscription.updated", sub("sub_1", "cus_1"), "evt_race");
    const results = await Promise.allSettled([
      billing.handleWebhook(payload, {}),
      billing.handleWebhook(payload, {}),
      billing.handleWebhook(payload, {}),
    ]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("webhookHandler maps signature failures to 400, in-flight duplicates to 409 and handler failures to 500", async () => {
    const adapter = makeAdapter();
    let fail = true;
    const billing = createBilling({
      adapter,
      webhookSecret: "whsec",
      onEvent: async () => {
        if (fail) throw new Error("boom");
      },
    });
    const app = new Hono();
    app.post("/webhook", billing.webhookHandler());
    const body = subscriptionEvent("subscription.updated", sub("sub_1", "cus_1"), "evt_http");

    let res = await app.request("/webhook", { method: "POST", body });
    expect(res.status).toBe(500);

    fail = false;
    res = await app.request("/webhook", { method: "POST", body });
    expect(res.status).toBe(200);

    adapter.verifyWebhook = () => false;
    res = await app.request("/webhook", { method: "POST", body });
    expect(res.status).toBe(400);

    adapter.verifyWebhook = () => true;
    await kv.set("covara:billing:evt:evt_inflight", "processing:other", { px: 60_000 });
    res = await app.request("/webhook", {
      method: "POST",
      body: subscriptionEvent("subscription.updated", sub("sub_1", "cus_1"), "evt_inflight"),
    });
    expect(res.status).toBe(409);
  });
});

describe("billing.reconcile", () => {
  let adapter: MockAdapter;
  let billing: Billing;
  let events: BillingEvent[];

  beforeEach(() => {
    adapter = makeAdapter();
    events = [];
    billing = createBilling({
      adapter,
      onEvent: async (event) => {
        events.push(event);
      },
    });
  });

  it("reports no drift when local matches the provider", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    events.length = 0;
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.subscriptionsChecked).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("creates a subscription missed entirely by webhooks and fires subscription.created", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({ kind: "missing_locally", eventType: "subscription.created", outcome: "applied" });
    expect(report.fixed).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "subscription.created", source: "reconcile" });
    expect(events[0].subscription?.id).toBe("sub_1");
    const stored = await billing.subscriptions!.get("sub_1");
    expect(stored?.source).toBe("reconcile");
    expect(stored?.account).toBe("acct-cus_1");
  });

  it("applies a missed status change as subscription.updated with the changed fields", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { status: "past_due", quantity: 3 }));
    events.length = 0;
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift[0]).toMatchObject({ kind: "changed", eventType: "subscription.updated" });
    expect(report.drift[0].changes.sort()).toEqual(["quantity", "status"]);
    expect(events.map((e) => e.type)).toEqual(["subscription.updated"]);
    expect((await billing.subscriptions!.get("sub_1"))?.subscription.status).toBe("past_due");
  });

  it("fires subscription.canceled when the provider canceled it", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { status: "canceled" }));
    events.length = 0;
    await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(events.map((e) => e.type)).toEqual(["subscription.canceled"]);
  });

  it("treats a subscription deleted at the provider (404) as canceled", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    events.length = 0;
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift[0]).toMatchObject({ kind: "missing_at_provider", eventType: "subscription.canceled" });
    expect(events[0].subscription?.status).toBe("canceled");
    expect((await billing.subscriptions!.get("sub_1"))?.subscription.status).toBe("canceled");

    events.length = 0;
    const again = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(again.drift).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("finds a local subscription missing from the list but present at the provider via getSubscription", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_moved", { status: "active" }));
    events.length = 0;
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(adapter.calls.get).toBe(1);
    expect(report.drift[0]).toMatchObject({ kind: "changed" });
    expect(report.drift[0].changes).toContain("customerId");
  });

  it("the provider wins when local state is ahead of it", async () => {
    await billing.handleWebhook(
      subscriptionEvent("subscription.canceled", sub("sub_1", "cus_1", { status: "canceled" })),
      {}
    );
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { status: "active" }));
    events.length = 0;
    await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(events.map((e) => e.type)).toEqual(["subscription.updated"]);
    expect((await billing.subscriptions!.get("sub_1"))?.subscription.status).toBe("active");
  });

  it("is idempotent: a second run finds nothing and fires no hooks", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    events.length = 0;
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("concurrent reconcile runs fire each drift's hooks once", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const slow = vi.fn(async (event: BillingEvent) => {
      events.push(event);
      await new Promise((r) => setTimeout(r, 10));
    });
    billing = createBilling({ adapter, onEvent: slow });
    await Promise.all([
      billing.reconcile({ customerId: "cus_1", retry: retryFast }),
      billing.reconcile({ customerId: "cus_1", retry: retryFast }),
    ]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("dryRun reports drift without firing hooks or writing state", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const report = await billing.reconcile({ customerId: "cus_1", dryRun: true, retry: retryFast });
    expect(report.dryRun).toBe(true);
    expect(report.drift[0].outcome).toBe("dry_run");
    expect(report.fixed).toBe(0);
    expect(events).toHaveLength(0);
    expect(await billing.subscriptions!.get("sub_1")).toBeNull();
  });

  it("never treats a provider API error as a deletion", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    events.length = 0;
    adapter.failList.push(new BillingError("boom", "stripe", 400));
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift).toEqual([]);
    expect(report.errors[0]).toMatchObject({ customerId: "cus_1", stage: "list", status: 400 });
    expect(events).toHaveLength(0);

    adapter.failGet.push(new BillingError("boom", "stripe", 400));
    const second = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(second.drift).toEqual([]);
    expect(second.errors[0]).toMatchObject({ subscriptionId: "sub_1", stage: "get" });
    expect((await billing.subscriptions!.get("sub_1"))?.subscription.status).toBe("active");
  });

  it("retries rate limits and 5xx with backoff, then gives up and reports", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    adapter.failList.push(new BillingError("slow down", "stripe", 429), new BillingError("oops", "stripe", 503));
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(adapter.calls.list).toBe(3);
    expect(report.errors).toEqual([]);
    expect(report.drift).toHaveLength(1);

    adapter.failList.push(
      new BillingError("slow down", "stripe", 429),
      new BillingError("slow down", "stripe", 429),
      new BillingError("slow down", "stripe", 429)
    );
    const failed = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(failed.errors[0]).toMatchObject({ stage: "list", status: 429 });
  });

  it("skips a drift when a webhook updates the subscription mid-reconcile", async () => {
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { status: "past_due" }));
    events.length = 0;
    const realList = adapter.listSubscriptions.bind(adapter);
    adapter.listSubscriptions = async (customerId) => {
      const result = await realList(customerId);
      return result;
    };
    const store = billing.subscriptions!;
    const originalListByCustomer = store.listByCustomer.bind(store);
    store.listByCustomer = async (customerId) => {
      const records = await originalListByCustomer(customerId);
      await billing.handleWebhook(
        subscriptionEvent("subscription.updated", sub("sub_1", "cus_1", { status: "unpaid" })),
        {}
      );
      return records;
    };
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift[0].outcome).toBe("skipped_concurrent_update");
    expect(events.map((e) => e.source ?? "webhook")).toEqual(["webhook"]);
    expect((await store.get("sub_1"))?.subscription.status).toBe("unpaid");
  });

  it("a failing hook during reconcile leaves state untouched so the next run retries", async () => {
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    let fail = true;
    billing = createBilling({
      adapter,
      onEvent: async (event) => {
        if (fail) throw new Error("hook down");
        events.push(event);
      },
    });
    const report = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(report.drift[0].outcome).toBe("failed");
    expect(report.errors[0]).toMatchObject({ stage: "apply", subscriptionId: "sub_1" });
    expect(await billing.subscriptions!.get("sub_1")).toBeNull();

    fail = false;
    const retry = await billing.reconcile({ customerId: "cus_1", retry: retryFast });
    expect(retry.drift[0].outcome).toBe("applied");
    expect(events).toHaveLength(1);
  });

  it("throws a clear error when no subscription store is available", async () => {
    const noStore = createBilling({ adapter, subscriptions: false });
    await expect(noStore.reconcile({ customerId: "cus_1" })).rejects.toThrow(/subscription store/i);
  });
});

describe("billing.reconcileAll", () => {
  it("walks provider pages and local-only customers", async () => {
    const adapter = makeAdapter();
    const events: BillingEvent[] = [];
    const billing = createBilling({ adapter, onEvent: (e) => void events.push(e) });
    adapter.remote.set("sub_a", sub("sub_a", "cus_a"));
    adapter.remote.set("sub_b", sub("sub_b", "cus_b"));
    adapter.remote.set("sub_c", sub("sub_c", "cus_c", { status: "trialing" }));
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_z", "cus_z")), {});
    events.length = 0;

    const report = await billing.reconcileAll({ retry: retryFast });
    expect(adapter.calls.listAll).toBe(2);
    expect(adapter.calls.list).toBe(0);
    expect(report.customersChecked).toBe(4);
    expect(report.drift.map((d) => `${d.subscriptionId}:${d.kind}`).sort()).toEqual([
      "sub_a:missing_locally",
      "sub_b:missing_locally",
      "sub_c:missing_locally",
      "sub_z:missing_at_provider",
    ]);
    expect(events).toHaveLength(4);
  });

  it("falls back to per-customer listing when the full listing fails", async () => {
    const adapter = makeAdapter();
    const billing = createBilling({ adapter });
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { status: "past_due" }));
    adapter.failListAll.push(new BillingError("bad", "stripe", 400));
    const report = await billing.reconcileAll({ retry: retryFast });
    expect(report.errors[0]).toMatchObject({ stage: "list_all" });
    expect(adapter.calls.list).toBe(1);
    expect(report.drift[0]).toMatchObject({ subscriptionId: "sub_1", kind: "changed" });
  });

  it("uses per-customer listing for adapters without listAllSubscriptions", async () => {
    const adapter = makeAdapter(false);
    const billing = createBilling({ adapter });
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const report = await billing.reconcileAll({ retry: retryFast });
    expect(adapter.calls.list).toBe(1);
    expect(report.drift).toEqual([]);
  });

  it("stops between customers when aborted", async () => {
    const adapter = makeAdapter(false);
    const billing = createBilling({ adapter });
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_2", "cus_2")), {});
    const controller = new AbortController();
    adapter.onList = () => controller.abort();
    const report = await billing.reconcileAll({ retry: retryFast, signal: controller.signal });
    expect(report.aborted).toBe(true);
    expect(report.customersChecked).toBe(1);
  });
});

describe("Reconciliation with a durable store", () => {
  it("works end-to-end over the Drizzle subscription store", async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migrateInternal(db);
    const adapter = makeAdapter();
    const billing = createBilling({ adapter, subscriptions: createDrizzleSubscriptionStore({ db }) });
    await billing.handleWebhook(subscriptionEvent("subscription.created", sub("sub_1", "cus_1")), {});
    adapter.remote.set("sub_1", sub("sub_1", "cus_1", { cancelAtPeriodEnd: true }));
    const report = await billing.reconcileAll({ retry: retryFast });
    expect(report.drift[0]).toMatchObject({ changes: ["cancelAtPeriodEnd"], outcome: "applied" });
    expect((await billing.subscriptions!.get("sub_1"))?.subscription.cancelAtPeriodEnd).toBe(true);
    await pglite.close();
  });
});

describe("createBillingReconcileTask", () => {
  it("defines a task that runs reconcileAll and schedules it on a cron", async () => {
    const adapter = makeAdapter();
    const billing = createBilling({ adapter });
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const helper = createBillingReconcileTask({ billing, cron: "*/30 * * * *" });
    expect(helper.task.name).toBe("covara:billing:reconcile");
    expect(helper.recurring).toMatchObject({ cron: "*/30 * * * *" });

    const output = await helper.task.handler(
      {
        taskId: "t",
        attempt: 1,
        scheduledAt: new Date(),
        startedAt: new Date(),
        workerId: "w",
        signal: new AbortController().signal,
        db: null,
        reportProgress: async () => {},
      },
      {}
    );
    expect(output).toMatchObject({ customersChecked: 1, driftFound: 1, fixed: 1, errors: 0 });

    const scheduleRecurring = vi.fn(async () => "sched_1");
    expect(await helper.schedule({ scheduleRecurring } as never)).toBe("sched_1");
    expect(scheduleRecurring).toHaveBeenCalledWith(helper.task, {}, helper.recurring);
  });

  it("supports interval scheduling and dry runs", async () => {
    const adapter = makeAdapter();
    const billing = createBilling({ adapter });
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const helper = createBillingReconcileTask({ billing, interval: 60_000, dryRun: true, name: "recon" });
    expect(helper.recurring).toEqual({ interval: 60_000, catchup: "skip" });
    const output = await helper.task.handler({ signal: new AbortController().signal } as never, {});
    expect(output).toMatchObject({ dryRun: true, driftFound: 1, fixed: 0 });
    expect(await billing.subscriptions!.get("sub_1")).toBeNull();
  });
});

describe("Router reconcile endpoint", () => {
  const build = (authorize?: (c: unknown) => boolean) => {
    const adapter = makeAdapter();
    adapter.remote.set("sub_1", sub("sub_1", "cus_1"));
    const billing = createBilling({ adapter });
    const app = new Hono();
    app.route(
      "/billing",
      createBillingRouter(billing, {
        getAccount: () => "acct",
        authorizeReconcile: authorize,
      })
    );
    return app;
  };

  it("is not mounted without an authorizeReconcile guard", async () => {
    const res = await build().request("/billing/reconcile", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("rejects unauthorized callers", async () => {
    const res = await build(() => false).request("/billing/reconcile", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });

  it("returns the report for authorized callers", async () => {
    const app = build(() => true);
    const res = await app.request("/billing/reconcile", {
      method: "POST",
      body: JSON.stringify({ customerId: "cus_1", dryRun: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drift: unknown[]; dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.drift).toHaveLength(1);

    const all = await app.request("/billing/reconcile", { method: "POST" });
    expect(all.status).toBe(200);
  });
});
