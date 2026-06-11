# Task Contracts

## Guarantees

### Execution Semantics
- **At-least-once execution**: Every scheduled task will be attempted at least once (unless cancelled)
- **Idempotency key respect**: Tasks with the same `idempotencyKey` run the handler at most once within `idempotencyRetentionMs` (default 24h); subsequent executions return the stored result. Requires a shared KV store to hold across workers/instances
- **Concurrency cap**: `maxConcurrency` is enforced via a distributed counter — at most N instances of a task type run concurrently across the fleet; a worker that can't reserve a slot leaves the task for another
- **State machine validity**: Tasks only transition through valid states:
  ```
  scheduled → claimed → running → success|failed|retry
  failed → dlq|retry|scheduled
  retry → scheduled
  dlq → scheduled (replay)
  ```

### Retry Behavior
- **Bounded retries**: Tasks retry up to `maxRetries` times before going to DLQ
- **Exponential backoff**: Retry delays increase exponentially with configurable base and multiplier
- **Jitter**: Retry times include random jitter to prevent thundering herd

### Claim/Lease
- **Exclusive execution**: Only one worker executes a task at a time (via claim mechanism)
- **Claim expiration**: If worker dies, claim expires after timeout, allowing reclaim
- **No dual execution**: CAS operations prevent split-brain dual execution

### Recurring Tasks
- **Scheduled execution**: Recurring tasks execute at specified intervals
- **Timezone honored**: Cron schedules are evaluated in the configured `timezone` (default UTC), so DST transitions shift wall-clock fire times correctly
- **Configurable catchup**: A `catchup` policy controls how missed occurrences (worker downtime / delayed tick) are handled — `"skip"` (default, fire once, no pile-up), `"last"` (coalesce all missed runs into a single execution), or `"all"` (re-run each missed occurrence between `lastRunAt` and now, bounded to 1000 per tick)
- **Drift control**: Fixed-rate vs fixed-delay semantics are explicit and honored

### Dead Letter Queue
- **Replay lineage**: Replaying a DLQ entry preserves `originalTaskId` and increments a `replayCount` that survives across repeated failures/replays; replays may carry an optional `replayedBy` actor and are recorded in a replay audit log
- **Alerting hook**: An optional `onDlqEnqueue` callback fires whenever a task lands in the DLQ (failures in the hook never affect DLQ persistence)
- **Bounded replay**: `retryAll` is bounded by a `limit` (default 100) and audited
- **Metrics**: `metrics()` exposes the current DLQ count and oldest-entry age

### Progress, Heartbeat, Result TTL
- **Progress reporting**: Handlers receive `ctx.reportProgress(percent, message?)` which persists progress (clamped 0–100) so a monitor can read it via `storage.getProgress`
- **Heartbeat**: Running tasks update `lastHeartbeatAt` independently of lock extension, so a stalled task is detectable even while its lock is still valid
- **Result TTL**: `resultTtlMs` (default 24h) sets `resultExpiresAt` on completed/failed records; expired records are removed lazily on the next read rather than accumulating forever

### Cloudflare Queues Backend
- **Push delivery**: `createCloudflareQueueProducer(binding)` enqueues tasks onto a Workers Queue and `createQueueConsumer({ kv, registry })` executes them from a `MessageBatch`, acking on success/dead-letter and retrying (with backoff `delaySeconds`) on retryable failure — no long-lived poller required

## Non-Guarantees

### Timing (What We Don't Promise)
- ❌ **Exact execution time**: Tasks execute "around" scheduled time, not precisely at it
- ❌ **Order preservation**: Tasks scheduled at same time may execute in any order
- ❌ **Clock accuracy**: System depends on reasonable clock accuracy (±seconds, not milliseconds)

### Execution (What We Don't Promise)
- ❌ **Exactly-once**: Delivery is at-least-once. `idempotencyKey` gives effectively-once execution within the retention window when a shared KV is configured, but without an idempotency key (or with a memory KV that isn't shared) a task may run more than once
- ❌ **Concurrency cap without shared KV**: `maxConcurrency` enforcement relies on the shared counter; with the per-process memory KV it only bounds a single instance
- ❌ **Execution duration limits**: Tasks can run indefinitely (unless timeout configured)
- ❌ **Permanent result persistence**: Completed task records (including results) are retained only until `resultExpiresAt` (`resultTtlMs`, default 24h), then removed on the next read; they are not kept forever

### Distributed (What We Don't Promise)
- ❌ **Fair distribution**: Work distribution across workers is best-effort, not guaranteed fair
- ❌ **Affinity**: Same task may execute on different workers across retries

## Failure Modes

### Worker Crash During Execution
- Task remains in `claimed` or `running` state
- Claim expires after timeout
- Another worker reclaims and retries
- `runCount` is incremented for retry tracking

### Database Unavailable
- Task scheduling fails (reported to caller)
- Running tasks may fail to update status
- On recovery, orphaned claims are reclaimed

### Poison Pill (Always-Failing Task)
- Retries up to `maxRetries`
- Moves to DLQ after exhausting retries
- Does NOT block other tasks in queue
- DLQ can be replayed with new idempotency key

### Clock Skew Between Workers
- Claim timeouts account for reasonable skew (recommended: timeout > 2× max skew)
- Scheduling uses server time, not worker time
- Backoff calculations use relative time

## Test Coverage

- `tests/invariants/task-state-machine.test.ts` - State machine invariants
- `tests/invariants/distributed-correctness.test.ts` - Distributed scenarios
- `tests/tasks/worker.test.ts` - Worker behavior
- `tests/tasks/scheduler.test.ts` - Scheduling
- `tests/tasks/retry.test.ts` - Retry logic
- `tests/tasks/dlq.test.ts` - Dead letter queue
- `tests/tasks/recurring.test.ts` - Recurring tasks
