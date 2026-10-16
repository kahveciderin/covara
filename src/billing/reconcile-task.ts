import { defineTask } from "@/tasks/define";
import type { RecurringConfig, TaskDefinition } from "@/tasks/types";
import type { TaskScheduler } from "@/tasks/scheduler";
import type { Billing } from "./index";
import type { BillingReconcileReport, ReconcileRetryOptions } from "./reconcile";

export interface BillingReconcileTaskOptions {
  billing: Billing;
  name?: string;
  // Cron expression (default every 15 minutes). Ignored when `interval` is set.
  cron?: string;
  interval?: number;
  timezone?: string;
  dryRun?: boolean;
  concurrency?: number;
  retry?: ReconcileRetryOptions;
  timeout?: number;
}

export interface BillingReconcileTaskInput {
  dryRun?: boolean;
}

export interface BillingReconcileSummary {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  customersChecked: number;
  subscriptionsChecked: number;
  driftFound: number;
  fixed: number;
  errors: number;
  aborted: boolean;
  drift: Array<{ subscriptionId: string; kind: string; eventType: string; outcome: string; changes: string[] }>;
}

export const summarizeReconcileReport = (report: BillingReconcileReport): BillingReconcileSummary => ({
  dryRun: report.dryRun,
  startedAt: report.startedAt.toISOString(),
  finishedAt: report.finishedAt.toISOString(),
  customersChecked: report.customersChecked,
  subscriptionsChecked: report.subscriptionsChecked,
  driftFound: report.drift.length,
  fixed: report.fixed,
  errors: report.errors.length,
  aborted: Boolean(report.aborted),
  drift: report.drift.map((d) => ({
    subscriptionId: d.subscriptionId,
    kind: d.kind,
    eventType: d.eventType,
    outcome: d.outcome,
    changes: d.changes,
  })),
});

export interface BillingReconcileTask {
  task: TaskDefinition<BillingReconcileTaskInput, BillingReconcileSummary>;
  recurring: RecurringConfig;
  schedule(scheduler: Pick<TaskScheduler, "scheduleRecurring">): Promise<string>;
}

export const createBillingReconcileTask = (options: BillingReconcileTaskOptions): BillingReconcileTask => {
  const task = defineTask<BillingReconcileTaskInput, BillingReconcileSummary>({
    name: options.name ?? "covara:billing:reconcile",
    maxConcurrency: 1,
    timeout: options.timeout,
    retry: { maxAttempts: 1 },
    handler: async (ctx, input) => {
      const report = await options.billing.reconcileAll({
        dryRun: input?.dryRun ?? options.dryRun,
        concurrency: options.concurrency,
        retry: options.retry,
        signal: ctx.signal,
      });
      return summarizeReconcileReport(report);
    },
  });

  const recurring: RecurringConfig = options.interval
    ? { interval: options.interval, catchup: "skip" }
    : { cron: options.cron ?? "*/15 * * * *", timezone: options.timezone, catchup: "skip" };
  if (recurring.timezone === undefined) delete recurring.timezone;

  return {
    task,
    recurring,
    schedule: (scheduler) => scheduler.scheduleRecurring(task, {}, recurring),
  };
};
