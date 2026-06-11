# Subscription Contracts

## Guarantees

### Event Delivery
- **Commit consistency**: Changelog entries and subscription events are emitted only *after* the database transaction commits. A mutation whose transaction rolls back (e.g. a throwing `onAfterUpdate`/`onAfterDelete` hook, or a failed commit) never produces a changelog entry or subscription event — there are no phantom events for uncommitted state.
- **At-least-once delivery**: Every mutation that matches a subscription's filter will generate at least one event
- **Event exclusivity**: A single mutation generates exactly one of: `added`, `changed`, `removed`, or `invalidate` per subscription (never multiple conflicting events)
- **Filter scope transitions**:
  - Item entering filter scope → `added`
  - Item leaving filter scope → `removed`
  - Item staying in scope + modified → `changed`
  - Item never in scope → no event

### Ordering
- **Per-connection ordering**: Events on a single connection are delivered in sequence number order
- **Monotonic sequences**: Sequence numbers always increase within a connection
- **No duplicate sequences**: Each sequence number appears at most once per connection

### Resume Semantics
- **Gap detection**: If client resumes from sequence N but server's oldest is N+k, server sends `invalidate`
- **Catchup delivery**: If gap is within retention window, missed events are sent in order
- **Fresh start**: Resume from sequence 0 sends all matching items as `existing` events

### Scope Changes
- **Immediate effect**: When user loses scope to an item, they receive `removed` immediately
- **Auth integration**: Scope changes (permission revocation) trigger appropriate events

## Non-Guarantees

### Ordering (What We Don't Promise)
- ❌ **Global ordering**: Events across different subscriptions are NOT globally ordered
- ❌ **Cross-resource ordering**: Events for different resources are NOT ordered relative to each other
- ❌ **Real-time delivery**: Network delays may cause events to arrive later than expected

### Delivery (What We Don't Promise)
- ❌ **Exactly-once delivery**: We guarantee at-least-once, not exactly-once
- ❌ **Bounded latency**: No SLA on event delivery time
- ❌ **Infinite retention**: Changelog has a max size; old events are pruned

### State (What We Don't Promise)
- ❌ **Snapshot consistency**: `existing` events represent a point-in-time snapshot; items may change during enumeration

## Failure Modes

### Network Disconnection
- Client receives `disconnected` callback
- On reconnect, client should resume from last sequence
- If gap too large, `invalidate` triggers full refetch

### Server Restart
- Active subscriptions are terminated
- Clients reconnect and resume normally
- Changelog persists across restarts (if configured)

### Changelog Overflow
- Oldest entries are pruned when max size reached
- Clients with stale sequences receive `invalidate`
- This is normal operation, not an error

### Slow Consumer / Backpressure
- Each connection has a bounded outbound queue (`sse.maxQueueBytes`, default 64 KB)
- When the queue is saturated the configured `sse.onBackpressure` policy applies:
  - `invalidate` (default): a single `invalidate` event is sent so the client refetches
  - `disconnect`: the connection is closed; the client reconnects and resumes from its last sequence
  - `drop`: the event is skipped for that connection (it may miss updates until the next sync)
- The server never buffers unboundedly for a stalled client

### Multi-Instance Delivery
- With a distributed KV store initialized via `initializeKV`, mutations on one instance are fanned out to subscribers on other instances (at-least-once)
- With the in-memory KV (per-process), cross-instance delivery is NOT provided

### External Writers (mutations outside the tracked db)
- Mutations made outside `useResource`/the tracked db (cron jobs, other services, manual edits) are NOT observed automatically
- Writers MUST call `recordExternalMutation(resource, type, { objectId? })` to notify subscribers; this emits an `invalidate` event (never `added`/`changed`/`removed`) so clients refetch
- This is the portable alternative to database-specific CDC; see the [mutation-tracking contract](./track-mutations.md)

## Test Coverage

- `tests/invariants/subscription-invariants.test.ts` - Core invariants
- `tests/resource/changelog-transaction-consistency.test.ts` - No changelog/event for rolled-back mutations
- `tests/subscription.test.ts` - Basic functionality
- `tests/subscription/backpressure.test.ts` - Load handling
- `tests/concurrency/subscribe-while-mutate.test.ts` - Concurrent operations
