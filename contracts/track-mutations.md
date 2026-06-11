# Mutation Tracking Contracts

## Guarantees

### Automatic Tracking in Procedures
- **ctx.db is tracked**: When using `useResource`, the `ctx.db` provided to procedure handlers is automatically wrapped with tracking for the current resource
- **Double-wrapping prevention**: If the db passed to `useResource` is already tracked, it won't be wrapped again (checked via `isTrackedDb`)
- **Multi-table support**: For procedures that modify multiple tables, pass a pre-configured tracked db to `config.db`

### Changelog Recording
- **Builder pattern completeness**: Every `insert()`, `update()`, `delete()` operation using the builder pattern records a changelog entry
- **Returning required for full tracking**: Mutations with `.returning()` capture the full object; without `.returning()`, only the ID is captured from input values
- **Previous state capture**: Updates and deletes capture `previousObject` via a pre-mutation SELECT (when `capturePreviousState` is true)

### Raw SQL Detection
- **Pattern matching**: INSERT, UPDATE, DELETE statements are detected via SQL string parsing
- **Table extraction**: Table name is extracted from the SQL and matched to registered tables
- **Partial tracking**: Raw SQL mutations record `objectId: "*"` (indicating unknown specific IDs)
- **Invalidate semantics**: Raw SQL mutations trigger `invalidate` events for subscribers and invalidate the query cache

### Batch Statements (`db.batch`)
- **Per-statement detection**: Each statement passed to `db.batch([...])` has its compiled SQL inspected and detected as a mutation
- **Coarse tracking**: Detected batch mutations record `objectId: "*"` and trigger `invalidate` (same contract as raw SQL); individual rows are not visible
- **Best-effort**: A statement whose SQL cannot be introspected is silently not tracked

### External-Writer Notification (`recordExternalMutation`)
- **Public entry point**: `recordExternalMutation(resource, type, { objectId? })` is exported for writers outside the tracked db (cron jobs, other services, manual edits, CDC)
- **Effects**: appends a changelog entry, invalidates the query cache, and sends subscribers an `invalidate` event
- **Coarse by default**: `objectId` defaults to `"*"`; no `object`/`previousObject` is carried, so the event is always `invalidate`
- **Portable alternative to CDC**: this is the supported mechanism for keeping Concave subscriptions/caches consistent when mutations bypass the tracked db

### Subscription Integration
- **Automatic push**: Mutations automatically push events to active subscriptions (when `pushToSubscriptions` is true)
- **Event type mapping**:
  - Insert → `added` event
  - Update → `changed` event (with filter scope tracking)
  - Delete → `removed` event
  - Raw SQL → `invalidate` event

### Transaction Handling
- **Transaction wrapping**: Wrapped transactions track all mutations within them
- **Commit-gated side effects**: Inside a tracked `db.transaction(...)`, changelog entries, subscription pushes, and cache invalidations are buffered and only emitted *after* the transaction commits
- **Rollback discards effects**: If a transaction rolls back (the callback throws), the buffered side effects are discarded — no changelog entry, subscription event, or cache invalidation is produced for uncommitted state

### Cache Invalidation
- **Table-level invalidation**: Any mutation to a table invalidates ALL cached queries that reference that table
- **Join-aware invalidation**: Cached queries are tagged with every table they reference, including joined tables; a mutation to ANY referenced table invalidates the cached result (not just the `FROM` table)
- **Automatic clearing**: Cache invalidation happens after a successful mutation (and after commit for transactions), before returning
- **TTL support**: Cached queries respect configured TTL independently of mutation-based invalidation

## Non-Guarantees

### Tracking Completeness
- ❌ **Unregistered tables**: Operations on tables not in the registry are NOT tracked
- ❌ **Raw SQL specificity**: Raw SQL cannot identify specific affected IDs (always uses `objectId: "*"`)
- ❌ **Complex raw SQL parsing**: CTEs, subqueries, and complex SQL patterns may not have their mutation type or table correctly detected

### Cache Behavior
- ❌ **Query-level granularity**: We don't track which rows a query touches; the entire cache for any referenced table is invalidated
- ❌ **Unjoined related tables**: Invalidation only covers tables the cached query actually references (via `from`/`join`); a mutation to a logically-related but unreferenced table does not invalidate the cache
- ❌ **Key set cleanup**: Cache key tracking sets may not be cleaned up when cached data expires via TTL

### Ordering
- ❌ **Global ordering**: Mutations across different database connections are NOT globally ordered
- ❌ **Atomic changelog + data**: The mutation and changelog entry are NOT in a single atomic transaction

## Failure Modes

### Mutation Error
- Changelog entry is NOT recorded if the underlying mutation fails
- No partial state: either both mutation and changelog succeed, or neither does

### Cache Unavailable
- If global KV is not configured, caching is silently disabled
- Cache invalidation attempts are no-ops when KV is unavailable

### SQL Parsing Failure
- If raw SQL cannot be parsed for mutation type/table, no changelog entry is recorded
- The mutation still executes successfully
- No `invalidate` event is triggered

### Previous State Fetch Failure
- If pre-mutation SELECT fails, the mutation continues with `previousObject: undefined`
- Subscription events may have incomplete data

## Invariants

### Idempotent Tracking
- Wrapping an already-wrapped database is safe (the outer wrapper detects and passes through)

### State Consistency
- `hasConflictHandler` prevents false positive mutations on `onConflictDoNothing`
- Empty update/delete results (no rows affected) produce no changelog entries

### Tracking Control
- `withoutTracking` completely disables all tracking for the callback scope
- `skipTables` excludes specific tables from any tracking

## Test Coverage

- `tests/track-mutations.test.ts` - Core functionality
  - Insert tracking (single, batch, returning)
  - Update tracking (with previousObject)
  - Delete tracking (with previousObject)
  - Raw SQL detection (INSERT, UPDATE, DELETE, SELECT)
  - Transaction tracking
  - Configuration options (skipTables, withoutTracking, customResourceName, capturePreviousState)
  - Edge cases (onConflictDoNothing, empty update/delete)
- Query caching tests (same file)
  - Cache behavior (hit, invalidate on mutation)
  - Manual invalidation
  - Configuration (per-table settings, custom prefix)
