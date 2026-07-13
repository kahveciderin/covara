# Subscription Contracts

## Guarantees

### Event Delivery
- **Commit consistency**: Changelog entries and subscription events are emitted only *after* the database transaction commits. A mutation whose transaction rolls back (e.g. a throwing `onAfterUpdate`/`onAfterDelete` hook, or a failed commit) never produces a changelog entry or subscription event — there are no phantom events for uncommitted state. (On engines without interactive transactions — Cloudflare D1 — single-statement writes auto-commit before after-hooks run, so a throwing after-hook cannot roll the write back; see the [mutation-tracking contract](./track-mutations.md#engines-without-interactive-transactions-cloudflare-d1).)
- **Actor attribution**: Changelog entries carry the authenticated user's ID (`userId`) when the mutation came through a resource route or mutation pipeline with a user in context; anonymous/raw-SQL/external mutations leave it unset.
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
- **Row-data scope changes (immediate)**: When a *mutation* moves a row out of a subscriber's scope — including scopes expressed against the row's own columns, e.g. `ownerOnly()` / `userId==<me>` — they receive `removed` immediately as part of normal mutation processing. A row entering scope yields `added`.
- **Out-of-band scope changes (periodic)**: Permission changes that are **not** driven by a row mutation (e.g. losing org membership, a revoked role) are caught by a periodic re-resolution of each subscription's scope. Every `sse.scopeRecheckMs` (default **30000ms**, per-resource, `0` disables) the subscription re-resolves its scope; if the resolved scope changed, the current matching set is recomputed and diffed against what the subscriber holds — rows that left scope emit `removed`, rows that entered emit `added`. The DB scan runs only when the resolved scope string actually changes; the new scope is also persisted so subsequent live events honor it (a revoked subscriber stops receiving live updates for rows it can no longer see).
  - **Detection limit**: the re-check reflects changes that the scope resolver itself recomputes (e.g. resolvers that query current membership/roles on each call). A resolver that only reads static fields off the user object captured at connect cannot observe an out-of-band change and still requires a reconnect.
  - **Session expiry** is handled separately: a subscription whose `authExpiresAt` has passed is torn down with an `invalidate`.

### Scalability
- **Per-resource isolation**: Subscriptions are stored sharded by resource (`covara:subs:byres:<resource>`, with a `covara:subs:resources` index for enumeration). A mutation loads and evaluates only the mutated resource's subscriptions — its cost scales with that resource's subscriber count, never the total subscription count across resources.
- **O(own subscriptions) disconnect**: SSE handlers are process-local, so each process tracks handler → subscription IDs in memory; a client disconnect removes exactly its own subscriptions without scanning the registry. (Cleanup of subscriptions left by a dead process falls back to a shard scan.)
- **Self-addressing IDs**: Subscription IDs embed their resource (`<uuid>:<resource>`), so ID-only operations (get/remove/seq-update) address the right shard with no secondary lookup. IDs remain opaque to clients.
- ❌ **Not promised**: Per-subscription *filter evaluation* within a resource is still O(subscribers-on-that-resource) per mutation — each subscription's filter/scope must be checked to decide delivery. This is in-memory predicate evaluation, not I/O.

### Aggregate Subscriptions (`GET /aggregate/subscribe`)
- **Recompute-on-change**: Unlike row subscriptions, aggregate subscriptions do not track individual rows. The server recomputes the full aggregate (honoring `groupBy`/`sum`/`avg`/`min`/`max`/`count`/`having` and the read scope + `filter`) whenever the resource is mutated, and emits an `aggregate` event with the new result.
- **Exactness**: Because the result is recomputed from the database, it is always exact for any grouping/having combination — no incremental-aggregation drift.
- **Initial snapshot**: On connect the server emits `connected` then one `aggregate` event with the current result (even when the resource is empty).
- **Scope-aware skip**: A subscription only recomputes when a mutated row could actually be in its scope. Each watcher carries the subscription's compiled read scope + `filter` and is handed the changed rows; if none match, the recompute is skipped entirely. This keeps a per-user aggregate (e.g. `userId==<me>`) from recomputing on every *other* user's insert, update, **or delete**. The changed rows passed are: the new row for inserts, new **and** previous state for updates (so scope entry/exit is caught), and the deleted rows' prior content for deletes. Unscoped/global aggregates (matcher `*`) always recompute.
- **Conservative fallback**: When the changed rows aren't available — raw-SQL/external invalidations (the framework doesn't know which rows changed) and cross-process notifications (row data is intentionally not shipped over pub/sub) — the watcher recomputes unconditionally. Skipping is only ever applied when it is provably safe; the result-level dedup below is the correctness backstop, so over-recomputing is always safe.
- **Debounced + deduplicated**: Bursts of mutations coalesce into a single recompute (`sse.aggregateDebounceMs`, default 150ms), and an `aggregate` event is suppressed when the recomputed result matches the last one sent under an **order-independent** comparison (group order is normalized, since `GROUP BY` has no stable `ORDER BY`).
- **Mutation coverage**: Inserts, updates, deletes, and raw-SQL/external invalidations all (potentially) trigger recompute. Cross-process mutations reach watchers via the `covara:aggregate` KV channel; double-delivery to the originating process is harmless (it collapses in the debounce).
- **Scope**: The read scope and `filter` are resolved once at connect and reused for every recompute for the life of the connection.

### Connection Multiplexing (`GET /__covara/stream`)
- **Invisible + default-on**: All live subscriptions on a client share one SSE stream; the client `createEventSource` returns an `EventSource`-shaped channel of that stream and the subscription managers are unchanged. Disable server-side with `createCovara({ multiplex: false })` or client-side with `multiplex: false`.
- **Per-channel semantics preserved**: Each channel is a full subscription — its auth scope, `filter`, `include`, `resumeFrom`/catchup, scope-recheck, and per-user/IP limits are resolved and enforced exactly as for a standalone `GET /subscribe`. The shared stream changes only the transport, never what a subscriber may see.
- **Framing + demux**: Server events are framed `event: mux` / `data: { c: <channelId>, n: <connected|message|aggregate|error>, d: <payload> }` and demultiplexed on the client back into the per-subscription events. A frame is only ever delivered to the channel whose id it carries.
- **Same-principal control**: The stream is bound to the authenticated user at open; a control `subscribe`/`unsubscribe` from a different user is rejected (`403`). The connection id is an unguessable server-minted uuid delivered only on the owning stream.
- **Reuses the fan-out engine**: Each channel registers its own handler id against the shared writer, so mutation push, cross-instance KV pub/sub, filter/scope matching, and backpressure are the existing machinery — no separate delivery path.
- **Graceful fallback**: When the stream can't be used — endpoint absent (`404`), no `fetch`/`EventSource`, or a control `POST` reaching a process without the stream (`409 stream_not_found`, e.g. multi-isolate) — the affected subscription transparently opens its own `GET /subscribe` connection. Correctness is identical; only connection sharing is lost.
- ❌ **Not promised**: Single-connection multiplexing across processes. The control `POST` must reach the process holding the stream; it does on Node/`startServer` (single process) but not necessarily on multi-isolate deployments, which fall back per the above.

## Non-Guarantees

### Ordering (What We Don't Promise)
- ❌ **Global ordering**: Events across different subscriptions are NOT globally ordered
- ❌ **Cross-resource ordering**: Events for different resources are NOT ordered relative to each other
- ❌ **Real-time delivery**: Network delays may cause events to arrive later than expected

### Aggregate Subscriptions (What We Don't Promise)
- ❌ **Per-mutation events**: An `aggregate` event is not emitted per row change — only the recomputed result, after debounce, and only when it differs from the last sent payload.
- ❌ **Resume/catchup**: Aggregate subscriptions carry a `seq` for reference but do not support changelog catchup/`resumeFrom`; a reconnect simply re-emits the current snapshot.

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
