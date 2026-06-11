# Background Tasks

Concave provides a distributed task queue for background job processing with automatic retries, scheduling, recurring tasks, and dead letter queues.

## Quick Start

```typescript
import {
  defineTask,
  initializeTasks,
  getTaskScheduler,
  getTaskRegistry,
  startTaskWorkers
} from "@kahveciderin/concave/tasks";
import { createKV } from "@kahveciderin/concave/kv";

// Initialize KV store (Redis for production, memory for dev)
const kv = await createKV({ type: "redis", redis: { url: "redis://localhost" } });

// Initialize task system
initializeTasks(kv);

// Define a task
const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  handler: async (ctx, input) => {
    console.log(`[${ctx.taskId}] Sending email to ${input.to}`);
    await sendEmail(input.to, input.subject, input.body);
    return { sent: true };
  },
});

// Register task
getTaskRegistry().register(sendEmailTask);

// Start workers
await startTaskWorkers(kv, getTaskRegistry(), 3);

// Enqueue a task
const taskId = await getTaskScheduler().enqueue(sendEmailTask, {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});
```

## Defining Tasks

### Basic Task

```typescript
import { defineTask } from "@kahveciderin/concave/tasks";
import { z } from "zod";

const processOrderTask = defineTask({
  name: "process-order",
  input: z.object({
    orderId: z.string(),
    userId: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
    invoiceId: z.string().optional(),
  }),
  handler: async (ctx, input) => {
    // Access task context
    console.log(`Task ${ctx.taskId}, attempt ${ctx.attempt}`);

    // Check for cancellation
    if (ctx.signal.aborted) {
      throw new Error("Task was cancelled");
    }

    const invoice = await processOrder(input.orderId);
    return { success: true, invoiceId: invoice.id };
  },
});
```

### Task Context

The handler receives a `TaskContext` with:

| Property | Type | Description |
|----------|------|-------------|
| `taskId` | `string` | Unique task identifier |
| `attempt` | `number` | Current attempt (1-based) |
| `scheduledAt` | `Date` | When task was scheduled |
| `startedAt` | `Date` | When execution started |
| `workerId` | `string` | Processing worker ID |
| `signal` | `AbortSignal` | For cancellation detection |
| `reportProgress` | `(percent: number, message?: string) => Promise<void>` | Report progress (0–100, clamped); stored on the task and readable via the scheduler |

### Reporting Progress

Long-running tasks can report progress, which is persisted on the task record separately from the
worker heartbeat:

```typescript
const importTask = defineTask({
  name: "import-rows",
  handler: async (ctx, input) => {
    for (let i = 0; i < input.rows.length; i++) {
      await importRow(input.rows[i]);
      await ctx.reportProgress((i / input.rows.length) * 100, `row ${i}`);
    }
  },
});

// Elsewhere
const task = await scheduler.getTask(taskId);
task?.progress; // { percent, message?, updatedAt }
```

While a task runs, the worker also writes a heartbeat (`lastHeartbeatAt`) every `heartbeatMs`
(default 10s) and extends its distributed lock; if the lock can no longer be extended, the task is
aborted via `ctx.signal` and rescheduled.

### Task Options

```typescript
const myTask = defineTask({
  name: "my-task",
  handler: async (ctx, input) => { /* ... */ },

  // Input/output validation
  input: z.object({ data: z.string() }),
  output: z.object({ result: z.number() }),

  // Retry configuration
  retry: {
    maxAttempts: 5,
    backoff: "exponential",  // "exponential" | "linear" | "fixed"
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    retryOn: (error) => error.name !== "ValidationError",
  },

  // Execution limits
  timeout: 30000,        // 30 second timeout
  maxConcurrency: 10,    // Enforced cap on parallel executions of this task type
  priority: 75,          // Higher = processed first (0-100)

  // Deduplication
  debounce: {
    windowMs: 5000,
    key: (input) => input.userId,  // Dedupe by user
  },

  // Idempotency
  idempotencyKey: (input) => `order-${input.orderId}`,
  idempotencyRetentionMs: 24 * 60 * 60 * 1000, // how long the completion is remembered (default 24h)

  // Result retention: how long a completed/failed task's result is kept before it is
  // lazily expired (deleted on next read). Default 24h.
  resultTtlMs: 60 * 60 * 1000,
});
```

### Result TTL

A completed (or failed) task's record carries `resultExpiresAt = completedAt + resultTtlMs`
(`resultTtlMs` defaults to 24 hours). Once expired, the task is deleted lazily the next time it is
read via `scheduler.getTask`/`getTasks`, so old results don't accumulate. Dead tasks are not subject
to this expiry — they live in the dead letter queue until purged.

### Idempotency Enforcement

When `idempotencyKey` is set, the first successful completion is recorded in the KV store
keyed by that value. If another execution with the same key runs while the record is still
within `idempotencyRetentionMs` (default 24 hours), it short-circuits and returns the stored
result instead of running the handler again. This makes retries and accidental
double-enqueues safe without bespoke dedupe logic. Use a distributed KV (Redis or the
Durable Object KV) so the guarantee holds across workers and instances.

### Concurrency Enforcement

`maxConcurrency` is enforced, not just advisory. Workers reserve a slot via a distributed
counter before running a task of that type and release it on completion; if the cap is
already reached, the task is left for a worker with free capacity. This bounds how many
instances of a given task run at once across the entire fleet.

## Scheduling Tasks

### Immediate Execution

```typescript
const scheduler = getTaskScheduler();

// Run as soon as a worker picks it up
const taskId = await scheduler.enqueue(myTask, { data: "hello" });
```

### Delayed Execution

```typescript
// Run after 5 minutes
await scheduler.schedule(myTask, { data: "hello" }, {
  delay: 5 * 60 * 1000,
});

// Run at specific time
await scheduler.schedule(myTask, { data: "hello" }, {
  at: new Date("2024-12-25T00:00:00Z"),
});

// With priority override
await scheduler.schedule(myTask, { data: "urgent" }, {
  delay: 1000,
  priority: 100,
});
```

### Recurring Tasks

```typescript
// Run every hour
await scheduler.scheduleRecurring(dailyReportTask, {}, {
  interval: 60 * 60 * 1000,
});

// Cron expression (every day at midnight UTC)
await scheduler.scheduleRecurring(dailyReportTask, {}, {
  cron: "0 0 * * *",
  timezone: "UTC",
});

// Every Monday at 9am in New York
await scheduler.scheduleRecurring(weeklyDigestTask, { type: "digest" }, {
  cron: "0 9 * * 1",
  timezone: "America/New_York",
});
```

#### Missed-Occurrence Catchup

If the scheduler is down across one or more scheduled fire times (a deploy, a crash, a paused
worker), the `catchup` policy decides what happens when it comes back:

```typescript
await scheduler.scheduleRecurring(generateReport, {}, {
  cron: "0 * * * *",
  catchup: "skip", // default
});
```

| Policy | Behavior |
|--------|----------|
| `"skip"` (default) | Fire exactly once, for the current occurrence; missed occurrences are dropped |
| `"last"` | Fire exactly once (run only the latest missed occurrence) |
| `"all"` | Enqueue one task per missed occurrence, capped at 1000, to backfill the gap |

### Task Management

```typescript
const scheduler = getTaskScheduler();

// Get task status
const task = await scheduler.getTask(taskId);
console.log(task?.status);  // "pending" | "scheduled" | "running" | "completed" | "failed" | "dead"

// Cancel a pending/scheduled task
const cancelled = await scheduler.cancel(taskId);

// Query tasks
const pendingTasks = await scheduler.getTasks({
  status: ["pending", "scheduled"],
  name: "send-email",
  createdAfter: new Date(Date.now() - 24 * 60 * 60 * 1000),
  limit: 100,
});

// Queue depth
const depth = await scheduler.getQueueDepth();
```

## Workers

### Starting Workers

```typescript
import { startTaskWorkers, createTaskWorker } from "@kahveciderin/concave/tasks";

// Start multiple workers
const workers = await startTaskWorkers(kv, registry, 3, {
  concurrency: 5,        // Tasks per worker
  pollIntervalMs: 1000,  // How often to check for tasks
  lockTtlMs: 30000,      // Task lock timeout
  heartbeatMs: 10000,    // Lock renewal interval
});

// Or create single worker with more control
const worker = createTaskWorker(kv, registry, {
  id: "worker-main",
  concurrency: 10,
  taskTypes: ["send-email", "process-order"],  // Only handle specific tasks
});

await worker.start();
```

### Worker Control

```typescript
// Pause processing (finish current tasks)
worker.pause();

// Resume processing
worker.resume();

// Drain: stop claiming new tasks, wait up to timeoutMs for in-flight tasks to finish
await worker.drain(30000);

// Stop. Pass { drain: true } to drain in-flight tasks first (optionally with a timeout)
await worker.stop({ drain: true, timeoutMs: 30000 });

// Stop immediately (default)
await worker.stop();

// Get stats
const stats = worker.getStats();
console.log(stats);
// {
//   id: "worker-main",
//   status: "running",
//   activeTasks: 3,
//   processedCount: 150,
//   failedCount: 2,
//   uptime: 3600000
// }
```

## Cloudflare Queues

On Cloudflare Workers there is no long-lived worker process to poll the KV queue. Instead, use the
Cloudflare Queues adapter: enqueue tasks onto a Queue producer binding, and process them in a queue
consumer handler. Retries are delegated to Cloudflare's native delivery (`message.retry()`), while
idempotency, the dead letter queue, and result storage still use your KV.

```typescript
import {
  createCloudflareQueueProducer,
  createQueueConsumer,
  getTaskRegistry,
} from "@kahveciderin/concave/tasks";
import { createDurableObjectKV } from "@kahveciderin/concave/kv";

export default {
  async fetch(req, env) {
    const producer = createCloudflareQueueProducer(env.TASK_QUEUE);
    const taskId = await producer.enqueue(sendEmailTask, { to: "a@b.com", subject: "Hi", body: "..." });
    // producer.enqueueBatch(task, [input1, input2]) for batches
    return new Response(taskId);
  },

  async queue(batch, env) {
    const kv = createDurableObjectKV(env.KV_DO);
    const consumer = createQueueConsumer({
      kv,
      registry: getTaskRegistry(),
      onDlqEnqueue: async (entry) => { /* alert */ },
    });
    await consumer.process(batch);
  },
};
```

The producer honors `delay`/`at` scheduling by converting it to the queue's `delaySeconds`. The
consumer runs each message through the registered task definition (with its `timeout`), caches
idempotent completions, stores results with `resultTtlMs`, retries via `message.retry({ delaySeconds })`
when the retry policy allows, and otherwise parks the task in the DLQ. Note that DLQ entries produced
by the queue consumer are **not** auto-requeued — replay them yourself with `dlq.retry(...)` (or rely
on a Cloudflare dead-letter queue binding).

Wrangler bindings (illustrative — binding names are yours to choose):

```toml
[[queues.producers]]
queue = "tasks"
binding = "TASK_QUEUE"      # env.TASK_QUEUE -> createCloudflareQueueProducer(env.TASK_QUEUE)

[[queues.consumers]]
queue = "tasks"
max_batch_size = 10
max_retries = 3
dead_letter_queue = "tasks-dlq"
```

## Retry Strategies

### Exponential Backoff (Default)

```typescript
retry: {
  maxAttempts: 5,
  backoff: "exponential",
  initialDelayMs: 1000,
  maxDelayMs: 60000,
}
// Delays: 1s, 2s, 4s, 8s, 16s (capped at 60s)
// Plus 10-20% jitter
```

### Linear Backoff

```typescript
retry: {
  backoff: "linear",
  initialDelayMs: 2000,
  maxDelayMs: 30000,
}
// Delays: 2s, 4s, 6s, 8s, ... (capped at 30s)
```

### Fixed Delay

```typescript
retry: {
  backoff: "fixed",
  initialDelayMs: 5000,
}
// Delays: 5s, 5s, 5s, ...
```

### Conditional Retry

```typescript
retry: {
  maxAttempts: 3,
  retryOn: (error) => {
    // Don't retry validation errors
    if (error.name === "ValidationError") return false;
    // Don't retry 4xx HTTP errors
    if (error.status >= 400 && error.status < 500) return false;
    // Retry everything else
    return true;
  },
}
```

## Dead Letter Queue

Tasks that exceed max attempts go to the dead letter queue:

```typescript
import { createDeadLetterQueue } from "@kahveciderin/concave/tasks";

const dlq = createDeadLetterQueue(kv, requeue);

// List failed tasks
const deadTasks = await dlq.list(100, 0);
for (const entry of deadTasks) {
  console.log(`Task ${entry.taskId} failed: ${entry.reason}`);
  console.log(`Attempts: ${entry.attempts}, Failed at: ${entry.failedAt}`);
}

// Get specific dead task
const entry = await dlq.get(taskId);

// Retry a dead task (creates new task, optionally recording who replayed it)
const newTaskId = await dlq.retry(taskId, "ops@example.com");

// Retry all dead tasks (default limit 100)
const retriedCount = await dlq.retryAll({ limit: 100, replayedBy: "ops@example.com" });

// Purge old entries (older than 7 days)
const purgedCount = await dlq.purge(7 * 24 * 60 * 60 * 1000);

// Count dead tasks
const count = await dlq.count();

// Replay lineage audit (most recent first)
const auditEntries = await dlq.audit(100);
// [{ originalTaskId, newTaskId, replayedAt, replayedBy?, replayCount }]
```

### Replay Lineage

Replaying a dead task creates a fresh task (new id, reset attempts and runtime fields) while
preserving lineage so you can trace it back to the original failure:

- `originalTaskId` always points to the very first task, even across multiple replays.
- `replayCount` increments on each replay.
- `replayedFromDlqAt` and (if provided) `replayedBy` record when and by whom the replay happened.

Each replay also appends a `DlqReplayAuditEntry` to a durable audit log, retrievable via `dlq.audit()`.

### Alerting on Dead Tasks

Provide an `onDlqEnqueue` callback to be notified the moment a task is parked in the DLQ — wire it to
your alerting/paging system. It receives the full `DeadLetterEntry`. Callback failures never affect
DLQ persistence (they are caught and swallowed).

```typescript
// On the worker config:
await startTaskWorkers(kv, registry, 3, {
  onDlqEnqueue: async (entry) => {
    await alert(`Task ${entry.taskId} (${entry.task.name}) dead after ${entry.attempts} attempts: ${entry.reason}`);
  },
});

// Or directly on the DLQ:
const dlq = createDeadLetterQueue(kv, requeue, {
  onDlqEnqueue: async (entry) => { /* ... */ },
});
```

## Resource Integration

Trigger tasks automatically when resources change:

```typescript
import { useResource } from "@kahveciderin/concave";
import { createTaskTriggerHooks, composeHooks } from "@kahveciderin/concave/tasks";

// Define the task
const sendWelcomeEmailTask = defineTask({
  name: "send-welcome-email",
  handler: async (ctx, input) => {
    await sendEmail(input.data.email, "Welcome!", "...");
  },
});

const auditLogTask = defineTask({
  name: "audit-log",
  handler: async (ctx, input) => {
    await logToAuditTable(input.event, input.resource, input.data, input.userId);
  },
});

// Create hooks that trigger tasks
const taskHooks = createTaskTriggerHooks({
  onCreate: [
    {
      task: sendWelcomeEmailTask,
      when: (data) => data.role === "user",  // Only for regular users
    },
    {
      task: auditLogTask,
      delay: 1000,  // Delay 1 second
    },
  ],
  onUpdate: [
    {
      task: auditLogTask,
      transform: (data) => ({ changes: data }),  // Custom input
    },
  ],
  onDelete: [
    { task: auditLogTask },
  ],
});

// Combine with other hooks
const hooks = composeHooks(taskHooks, {
  onBeforeCreate: async (ctx, data) => {
    return { ...data, createdAt: new Date() };
  },
});

// Use in resource
app.route("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
  hooks,
}));
```

### Trigger Options

```typescript
interface ResourceTaskTrigger {
  task: TaskDefinition;      // The task to trigger
  when?: (data) => boolean;  // Condition for triggering
  transform?: (data) => any; // Transform data to task input
  delay?: number;            // Delay in milliseconds
}
```

## Distributed Locking

Tasks use distributed locking to prevent duplicate execution:

```typescript
import { createTaskLock } from "@kahveciderin/concave/tasks";

const lock = createTaskLock(kv);

// Acquire lock (returns true if successful)
const acquired = await lock.acquire(taskId, workerId, 30);

// Extend lock (heartbeat)
const extended = await lock.extend(taskId, workerId, 30);

// Release lock
await lock.release(taskId, workerId);

// Check lock holder
const isHeld = await lock.isHeld(taskId, workerId);
```

## Priority Queues

Tasks are processed by priority buckets (0-25, 25-50, 50-75, 75-100):

```typescript
// High priority (processed first)
const urgentTask = defineTask({
  name: "urgent-task",
  priority: 100,
  handler: async () => { /* ... */ },
});

// Normal priority (default: 50)
const normalTask = defineTask({
  name: "normal-task",
  handler: async () => { /* ... */ },
});

// Low priority (processed last)
const lowPriorityTask = defineTask({
  name: "background-task",
  priority: 10,
  handler: async () => { /* ... */ },
});

// Override at schedule time
await scheduler.schedule(normalTask, {}, { priority: 90 });
```

## Idempotency

Prevent duplicate task execution:

```typescript
const processPaymentTask = defineTask({
  name: "process-payment",
  idempotencyKey: (input) => `payment-${input.paymentId}`,
  handler: async (ctx, input) => {
    // This will only run once per paymentId
    await chargeCard(input.paymentId);
  },
});

// These create only one task (same idempotency key)
await scheduler.enqueue(processPaymentTask, { paymentId: "pay_123" });
await scheduler.enqueue(processPaymentTask, { paymentId: "pay_123" });

// Or override at schedule time
await scheduler.schedule(myTask, input, {
  idempotencyKey: "custom-key-123",
});
```

## Recurring Task Management

```typescript
import { createRecurringManager, startRecurringScheduler } from "@kahveciderin/concave/tasks";

const recurring = createRecurringManager(kv);

// Create recurring schedule
const scheduleId = await recurring.create(dailyReportTask, {}, {
  cron: "0 0 * * *",
  timezone: "America/New_York",
});

// Pause a schedule
await recurring.pause(scheduleId);

// Resume a schedule
await recurring.resume(scheduleId);

// Delete a schedule
await recurring.delete(scheduleId);

// Get schedule details
const schedule = await recurring.get(scheduleId);
// {
//   id: "...",
//   taskName: "daily-report",
//   cron: "0 0 * * *",
//   timezone: "America/New_York",
//   enabled: true,
//   lastRunAt: 1703980800000,
//   nextRunAt: 1704067200000,
// }

// List all schedules
const schedules = await recurring.list();

// Start the recurring scheduler (checks every second)
const stop = startRecurringScheduler(kv, async (taskName, input) => {
  const task = registry.get(taskName);
  if (task) {
    return scheduler.enqueue(task, input);
  }
  throw new Error(`Unknown task: ${taskName}`);
}, 1000);

// Stop the recurring scheduler
stop();
```

## Full Example

```typescript
import { useResource, createConcave } from "@kahveciderin/concave";
import { startServer } from "@kahveciderin/concave/node";
import { createKV } from "@kahveciderin/concave/kv";
import {
  defineTask,
  initializeTasks,
  getTaskScheduler,
  getTaskRegistry,
  startTaskWorkers,
  startRecurringScheduler,
  createTaskTriggerHooks,
} from "@kahveciderin/concave/tasks";
import { z } from "zod";

const app = createConcave();

// Initialize KV and tasks
const kv = await createKV({ type: "redis", redis: { url: process.env.REDIS_URL } });
initializeTasks(kv);

const registry = getTaskRegistry();
const scheduler = getTaskScheduler();

// Define tasks
const sendWelcomeEmail = defineTask({
  name: "send-welcome-email",
  input: z.object({ userId: z.string(), email: z.string() }),
  retry: { maxAttempts: 3, backoff: "exponential" },
  handler: async (ctx, { userId, email }) => {
    await emailService.send(email, "Welcome!", `Hello user ${userId}!`);
  },
});

const generateReport = defineTask({
  name: "generate-daily-report",
  timeout: 5 * 60 * 1000,  // 5 minutes
  handler: async (ctx) => {
    const report = await analytics.generateDailyReport();
    await storage.upload(`reports/${new Date().toISOString()}.pdf`, report);
  },
});

// Register tasks
registry.register(sendWelcomeEmail);
registry.register(generateReport);

// Resource with task triggers
const userTaskHooks = createTaskTriggerHooks({
  onCreate: [{
    task: sendWelcomeEmail,
    transform: (user) => ({ userId: user.id, email: user.email }),
  }],
});

app.route("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
  hooks: userTaskHooks,
}));

// Schedule recurring task
await scheduler.scheduleRecurring(generateReport, {}, {
  cron: "0 6 * * *",  // Every day at 6am
  timezone: "UTC",
});

// Start workers and recurring scheduler
await startTaskWorkers(kv, registry, 3, { concurrency: 5 });
const stopRecurring = startRecurringScheduler(kv, async (name, input) => {
  const task = registry.get(name);
  return task ? scheduler.enqueue(task, input) : "";
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  stopRecurring();
  // Workers will finish current tasks
});

await startServer(app, { port: 3000 });
```

## Best Practices

1. **Always set timeouts** - Prevent tasks from running indefinitely
2. **Use idempotency keys** - For critical operations like payments
3. **Set appropriate retry strategies** - Don't retry non-transient errors
4. **Monitor dead letter queue** - Set up alerts for failed tasks
5. **Use priority wisely** - Reserve high priority for time-sensitive tasks
6. **Scale workers horizontally** - Run workers on multiple machines for throughput
7. **Use Redis in production** - Memory storage doesn't persist across restarts
