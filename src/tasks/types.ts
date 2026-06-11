import { z } from "zod";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "dead";

export interface RetryConfig {
  maxAttempts?: number;
  backoff?: "exponential" | "linear" | "fixed";
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: Error) => boolean;
}

export interface DebounceConfig {
  windowMs: number;
  key: (input: unknown) => string;
}

export interface TaskProgress {
  percent: number;
  message?: string;
  updatedAt: number;
}

export interface TaskContext {
  taskId: string;
  attempt: number;
  scheduledAt: Date;
  startedAt: Date;
  workerId: string;
  signal: AbortSignal;
  db: unknown;
  reportProgress: (percent: number, message?: string) => Promise<void>;
}

export interface TaskDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  input?: z.ZodSchema<TInput>;
  output?: z.ZodSchema<TOutput>;
  handler: (ctx: TaskContext, input: TInput) => Promise<TOutput>;
  retry?: RetryConfig;
  timeout?: number;
  priority?: number;
  maxConcurrency?: number;
  debounce?: DebounceConfig;
  idempotencyKey?: (input: TInput) => string;
  idempotencyRetentionMs?: number;
  resultTtlMs?: number;
}

export type CatchupPolicy = "skip" | "all" | "last";

export interface RecurringConfig {
  cron?: string;
  interval?: number;
  timezone?: string;
  catchup?: CatchupPolicy;
}

export interface Task<TInput = unknown> {
  id: string;
  name: string;
  input: TInput;
  status: TaskStatus;
  priority: number;
  createdAt: number;
  scheduledFor: number;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  result?: unknown;
  idempotencyKey?: string;
  recurring?: RecurringConfig;
  progress?: TaskProgress;
  lastHeartbeatAt?: number;
  resultExpiresAt?: number;
  originalTaskId?: string;
  replayCount?: number;
  replayedFromDlqAt?: number;
  replayedBy?: string;
}

export interface ScheduleOptions {
  delay?: number;
  at?: Date;
  priority?: number;
  idempotencyKey?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  name?: string | string[];
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  offset?: number;
}

export interface DeadLetterEntry {
  taskId: string;
  task: Task;
  failedAt: number;
  reason: string;
  attempts: number;
  originalTaskId?: string;
  replayedFromDlqAt?: number;
  replayedBy?: string;
  replayCount?: number;
}

export interface DlqMetrics {
  count: number;
  oldestEntryAgeMs: number | null;
}

export interface RecurringConfigForCalc {
  cron?: string;
  interval?: number;
  timezone?: string;
  catchup?: CatchupPolicy;
}

export interface RecurringSchedule {
  id: string;
  taskName: string;
  input: unknown;
  cron?: string;
  interval?: number;
  timezone: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  createdAt: number;
  catchup?: CatchupPolicy;
}

export interface WorkerStats {
  id: string;
  status: "running" | "paused" | "stopped";
  activeTasks: number;
  processedCount: number;
  failedCount: number;
  uptime: number;
}

export interface WorkerConfig {
  id?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  taskTypes?: string[];
  lockTtlMs?: number;
  heartbeatMs?: number;
  onDlqEnqueue?: (entry: DeadLetterEntry) => void | Promise<void>;
}

export interface StopOptions {
  drain?: boolean;
  timeoutMs?: number;
}
