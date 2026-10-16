import type { BillingSubscriptionStore, StoredSubscription } from "./subscription-store";
import {
  BillingError,
  type BillingAdapter,
  type BillingEvent,
  type BillingEventType,
  type BillingSubscription,
} from "./types";

export interface ReconcileRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ReconcileOptions {
  dryRun?: boolean;
  retry?: ReconcileRetryOptions;
  signal?: AbortSignal;
}

export interface ReconcileAllOptions extends ReconcileOptions {
  // Number of customers reconciled in parallel. Keep low to respect provider
  // rate limits. Default 1.
  concurrency?: number;
  // "provider" (default) enumerates every provider subscription via
  // listAllSubscriptions when the adapter supports it; "local" only re-checks
  // customers already known locally.
  source?: "provider" | "local";
}

export type ReconcileDriftKind = "missing_locally" | "changed" | "missing_at_provider";

export type ReconcileOutcome =
  | "applied"
  | "already_applied"
  | "skipped_concurrent_update"
  | "failed"
  | "dry_run";

export interface BillingReconcileDrift {
  subscriptionId: string;
  customerId: string;
  kind: ReconcileDriftKind;
  changes: string[];
  eventType: BillingEventType;
  local?: BillingSubscription;
  remote: BillingSubscription;
  outcome: ReconcileOutcome;
  error?: string;
}

export interface BillingReconcileError {
  stage: "list" | "list_all" | "get" | "apply";
  customerId?: string;
  subscriptionId?: string;
  message: string;
  status?: number;
}

export interface BillingReconcileReport {
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  customersChecked: number;
  subscriptionsChecked: number;
  drift: BillingReconcileDrift[];
  fixed: number;
  errors: BillingReconcileError[];
  aborted?: boolean;
}

export type ApplyReconciledEvent = (
  event: BillingEvent
) => Promise<"applied" | "already_applied" | "in_flight">;

export interface ReconcilerDeps {
  adapter: BillingAdapter;
  store: () => BillingSubscriptionStore | null;
  apply: ApplyReconciledEvent;
  persist: (event: BillingEvent) => Promise<void>;
}

const TERMINAL: ReadonlySet<string> = new Set(["canceled", "expired"]);

const COMPARED_FIELDS = [
  "customerId",
  "status",
  "priceId",
  "productId",
  "quantity",
  "cancelAtPeriodEnd",
  "currentPeriodStart",
  "currentPeriodEnd",
  "trialEndsAt",
] as const;

const normalize = (field: (typeof COMPARED_FIELDS)[number], value: unknown): unknown => {
  if (value === null || value === undefined) return field === "cancelAtPeriodEnd" ? false : null;
  if (value instanceof Date) return value.getTime();
  return value;
};

export const diffSubscriptions = (local: BillingSubscription, remote: BillingSubscription): string[] =>
  COMPARED_FIELDS.filter((field) => normalize(field, local[field]) !== normalize(field, remote[field]));

const fingerprint = (sub: BillingSubscription | undefined): string =>
  sub ? COMPARED_FIELDS.map((field) => String(normalize(field, sub[field]))).join("|") : "none";

const hash = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const errorInfo = (err: unknown): { message: string; status?: number } => ({
  message: err instanceof Error ? err.message : String(err),
  status: err instanceof BillingError ? err.status : undefined,
});

const isRetryable = (err: unknown): boolean => {
  if (err instanceof BillingError) {
    return err.status === 429 || (err.status !== undefined && err.status >= 500);
  }
  return err instanceof TypeError;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const withRetry = async <T>(fn: () => Promise<T>, retry: ReconcileRetryOptions = {}): Promise<T> => {
  const attempts = Math.max(1, retry.attempts ?? 4);
  const base = retry.baseDelayMs ?? 1000;
  const max = retry.maxDelayMs ?? 30_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      await sleep(Math.min(max, base * 2 ** (attempt - 1)));
    }
  }
};

interface PendingDrift {
  kind: ReconcileDriftKind;
  changes: string[];
  local?: StoredSubscription;
  remote: BillingSubscription;
}

const eventTypeFor = (drift: PendingDrift): BillingEventType => {
  if (drift.kind === "missing_at_provider") return "subscription.canceled";
  const remoteTerminal = TERMINAL.has(drift.remote.status);
  if (drift.kind === "missing_locally") return remoteTerminal ? "subscription.canceled" : "subscription.created";
  const localTerminal = drift.local ? TERMINAL.has(drift.local.subscription.status) : false;
  return remoteTerminal && !localTerminal ? "subscription.canceled" : "subscription.updated";
};

export const createReconciler = (deps: ReconcilerDeps) => {
  const requireStore = (): BillingSubscriptionStore => {
    const store = deps.store();
    if (!store) {
      throw new Error(
        "Billing reconciliation requires a subscription store. Configure a global KV or pass `subscriptions` to createBilling."
      );
    }
    return store;
  };

  const newReport = (dryRun: boolean): BillingReconcileReport => ({
    dryRun,
    startedAt: new Date(),
    finishedAt: new Date(),
    customersChecked: 0,
    subscriptionsChecked: 0,
    drift: [],
    fixed: 0,
    errors: [],
  });

  const applyDrift = async (
    store: BillingSubscriptionStore,
    drift: PendingDrift,
    report: BillingReconcileReport,
    options: ReconcileOptions
  ): Promise<void> => {
    const eventType = eventTypeFor(drift);
    const entry: BillingReconcileDrift = {
      subscriptionId: drift.remote.id,
      customerId: drift.remote.customerId,
      kind: drift.kind,
      changes: drift.changes,
      eventType,
      local: drift.local?.subscription,
      remote: drift.remote,
      outcome: "dry_run",
    };
    report.drift.push(entry);
    if (options.dryRun) return;

    // A webhook may have landed between our read and now; the provider
    // snapshot we hold could be older than it, so leave it to the next run.
    const current = await store.get(drift.remote.id);
    const unchanged =
      (current?.updatedAt ?? null) === (drift.local?.updatedAt ?? null) &&
      fingerprint(current?.subscription) === fingerprint(drift.local?.subscription);
    if (!unchanged) {
      entry.outcome = "skipped_concurrent_update";
      return;
    }

    const event: BillingEvent = {
      id: `reconcile:${deps.adapter.provider}:${drift.remote.id}:${hash(
        `${eventType}|${fingerprint(drift.local?.subscription)}|${fingerprint(drift.remote)}`
      )}`,
      type: eventType,
      provider: deps.adapter.provider,
      customerId: drift.remote.customerId,
      subscription: drift.remote,
      metadata: drift.remote.metadata,
      source: "reconcile",
      raw: { reconcile: true, kind: drift.kind, changes: drift.changes, local: drift.local?.subscription ?? null },
    };

    try {
      const result = await deps.apply(event);
      if (result === "in_flight") {
        entry.outcome = "skipped_concurrent_update";
        return;
      }
      if (result === "already_applied") await deps.persist(event);
      entry.outcome = result;
      report.fixed++;
    } catch (err) {
      const info = errorInfo(err);
      entry.outcome = "failed";
      entry.error = info.message;
      report.errors.push({
        stage: "apply",
        customerId: drift.remote.customerId,
        subscriptionId: drift.remote.id,
        ...info,
      });
    }
  };

  const reconcileCustomer = async (
    store: BillingSubscriptionStore,
    customerId: string,
    remoteKnown: BillingSubscription[] | undefined,
    report: BillingReconcileReport,
    options: ReconcileOptions
  ): Promise<void> => {
    let remote: BillingSubscription[];
    try {
      remote = remoteKnown ?? (await withRetry(() => deps.adapter.listSubscriptions(customerId), options.retry));
    } catch (err) {
      report.errors.push({ stage: "list", customerId, ...errorInfo(err) });
      return;
    }
    report.customersChecked++;

    const locals = await store.listByCustomer(customerId);
    const localById = new Map(locals.map((record) => [record.subscription.id, record]));
    const remoteIds = new Set(remote.map((s) => s.id));
    const pending: PendingDrift[] = [];

    for (const sub of remote) {
      report.subscriptionsChecked++;
      const local = localById.get(sub.id);
      if (!local) {
        pending.push({ kind: "missing_locally", changes: [], remote: sub });
        continue;
      }
      const changes = diffSubscriptions(local.subscription, sub);
      if (changes.length > 0) pending.push({ kind: "changed", changes, local, remote: sub });
    }

    for (const local of locals) {
      if (remoteIds.has(local.subscription.id)) continue;
      report.subscriptionsChecked++;
      let fetched: BillingSubscription | null;
      try {
        fetched = await withRetry(() => deps.adapter.getSubscription(local.subscription.id), options.retry);
      } catch (err) {
        report.errors.push({ stage: "get", customerId, subscriptionId: local.subscription.id, ...errorInfo(err) });
        continue;
      }
      if (fetched === null) {
        if (TERMINAL.has(local.subscription.status)) continue;
        pending.push({
          kind: "missing_at_provider",
          changes: ["status"],
          local,
          remote: { ...local.subscription, status: "canceled" },
        });
        continue;
      }
      const changes = diffSubscriptions(local.subscription, fetched);
      if (changes.length > 0) pending.push({ kind: "changed", changes, local, remote: fetched });
    }

    for (const drift of pending) await applyDrift(store, drift, report, options);
  };

  const reconcile = async (
    input: { customerId: string } & ReconcileOptions
  ): Promise<BillingReconcileReport> => {
    const store = requireStore();
    const report = newReport(Boolean(input.dryRun));
    await reconcileCustomer(store, input.customerId, undefined, report, input);
    report.finishedAt = new Date();
    return report;
  };

  const reconcileAll = async (options: ReconcileAllOptions = {}): Promise<BillingReconcileReport> => {
    const store = requireStore();
    const report = newReport(Boolean(options.dryRun));
    const byCustomer = new Map<string, BillingSubscription[]>();
    let listedAll = false;

    const listAll = deps.adapter.listAllSubscriptions?.bind(deps.adapter);
    if (listAll && options.source !== "local") {
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          if (options.signal?.aborted) break;
          const page = await withRetry(() => listAll({ cursor }), options.retry);
          for (const sub of page.subscriptions) {
            const list = byCustomer.get(sub.customerId) ?? [];
            list.push(sub);
            byCustomer.set(sub.customerId, list);
          }
          cursor = page.nextCursor && !seen.has(page.nextCursor) ? page.nextCursor : undefined;
          if (cursor) seen.add(cursor);
        } while (cursor);
        listedAll = !options.signal?.aborted;
      } catch (err) {
        report.errors.push({ stage: "list_all", ...errorInfo(err) });
      }
    }

    const customers = new Set<string>([...byCustomer.keys(), ...(await store.listCustomers())]);
    const queue = [...customers];
    const concurrency = Math.max(1, options.concurrency ?? 1);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (options.signal?.aborted) {
          report.aborted = true;
          return;
        }
        const customerId = queue.shift();
        if (customerId === undefined) return;
        const known = listedAll ? (byCustomer.get(customerId) ?? []) : undefined;
        await reconcileCustomer(store, customerId, known, report, options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
    if (options.signal?.aborted && queue.length > 0) report.aborted = true;
    report.finishedAt = new Date();
    return report;
  };

  return { reconcile, reconcileAll };
};
