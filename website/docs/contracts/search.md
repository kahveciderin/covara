# Search Contracts

## Guarantees

### Search Endpoint
- **Automatic availability**: `/search` endpoint is available on all resources when a global search adapter is configured
- **Zero-config default**: All fields are searchable by default without explicit configuration
- **Query required**: Search endpoint requires a `q` parameter and returns 400 if missing
- **Graceful degradation**: Returns 404 if no search adapter configured (search simply isn't available; not an error in production)

### Auto-Indexing
- **Create → index**: New documents are indexed immediately after successful database insert
- **Update → re-index**: Modified documents are re-indexed after successful database update
- **Delete → remove**: Documents are removed from index after successful database delete
- **Index errors don't fail mutations**: If indexing fails, the database mutation still succeeds (logged as error)

### Transactional Outbox (opt-in via `search.outbox: true`)
- **At-least-once convergence**: When the outbox is enabled, every index/delete op is persisted to a durable KV queue at mutation time and retried until it succeeds or is parked, guaranteeing the index eventually converges with the database (no silent drops on transient backend failure)
- **Exponential backoff**: Failed ops are retried with `base * 2^attempts` backoff, capped at 5 minutes (default base 1s)
- **Dead set**: Ops that exceed `maxAttempts` (default 10) are moved to a dead set and logged, never silently discarded; inspect via `getSearchOutboxStats()`
- **Requires a global KV**: With no global KV registered, enabling `outbox` is a no-op
- **Drainer**: On Node a background `setInterval` drains the queue automatically; on Workers the application must call `drainSearchOutbox()` from a scheduled/queue handler (no long-lived process)

### Field Configuration
- **Array fields**: When `fields` is an array, only those fields are searched
- **Weight support**: Field weights are passed to the search adapter for boosting
- **Searchable flag**: `searchable: false` excludes a field from search queries

### Filter Integration
- **Post-filter**: RSQL filters are applied after search results are returned
- **Full operator support**: All standard RSQL operators work with search results

## Non-Guarantees

### Search Behavior (What We Don't Promise)
- ❌ **Exact matching**: Search is fuzzy by default; exact match not guaranteed
- ❌ **Consistent scoring**: Search scores may vary between adapter implementations
- ❌ **Instant indexing**: Index updates may have slight delay (OpenSearch refresh)
- ❌ **Offline search**: Memory adapter data is lost on restart

### Data Consistency (What We Don't Promise)
- ❌ **Index-database sync**: Index may briefly be out of sync with database. With `search.outbox` enabled, the index converges at-least-once; without it, a failed inline index op is dropped (one immediate retry) and the index can stay stale until the row is touched again
- ❌ **Transactional indexing**: Index updates are not part of the database transaction even with the outbox — the outbox provides eventual at-least-once convergence, not atomic index+DB commits
- ❌ **Automatic reindexing**: Existing data is not automatically indexed on startup

### Performance (What We Don't Promise)
- ❌ **Bounded latency**: Search latency depends on adapter and index size
- ❌ **Unlimited results**: Results are capped at 100 per request

## Failure Modes

### No Search Adapter
- Endpoint returns 404 Not Found (search not available)
- Auto-indexing does nothing (silent)
- Resource CRUD operations work normally

### Index Error
- Index/delete errors are logged but don't fail mutations
- Search continues to work with potentially stale data
- No automatic retry of failed index operations

### Search Error
- Endpoint returns 500 with `SearchError` (RFC 7807 Problem Details format)
- Includes `index` name and `originalError` message in details
- RSQL filter errors return 400 with `ValidationError`

### Missing Query Parameter
- Endpoint returns 400 with `ValidationError`
- Message: "Missing query parameter 'q'"

## Test Coverage

- `tests/search/adapter.test.ts` - Global adapter registration
- `tests/search/memory-adapter.test.ts` - Memory adapter behavior
- `tests/search/endpoint.test.ts` - Search endpoint functionality
- `tests/search/auto-index.test.ts` - Auto-indexing hooks
