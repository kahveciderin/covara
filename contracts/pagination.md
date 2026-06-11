# Pagination Contracts

## Guarantees

### Cursor Integrity
- **Tamper detection**: Modified cursors are rejected with clear error
- **Encoding stability**: Cursor format is stable within major version
- **Opaque to client**: Cursors are treated as opaque strings; clients should not parse them

### Result Set Properties
- **No duplicates**: Paginating through a static dataset returns each item exactly once
- **No gaps**: Paginating through a static dataset returns all items
- **Stable ordering**: Items are returned in consistent order based on `orderBy` fields

### Ordering
- **Multi-field support**: Can order by multiple fields (e.g., `orderBy=score:desc,id`)
- **Tie-breaking**: Always includes unique field (usually `id`) for deterministic ordering
- **Null handling**: Null values sort last (configurable)

### Limits
- **Server-enforced max**: Requests cannot exceed server's max page size
- **Default applied**: If no limit specified, server applies default

## Non-Guarantees

### Consistency (What We Don't Promise)
- ❌ **Snapshot isolation**: Dataset may change between page fetches
- ❌ **Repeatable reads**: Same cursor may return different results after mutations
- ❌ **Insert visibility**: New items may appear in "already fetched" pages

### Behavior Under Mutation (What We Don't Promise)
- ❌ **Insert ordering**: Items inserted between fetches may appear in unexpected positions
- ❌ **Delete handling**: Deleted items may cause apparent "skips"
- ❌ **Update consistency**: Updated items may move between pages

### Performance (What We Don't Promise)
- ❌ **Constant time**: Pagination performance may vary with dataset size
- ❌ **Cursor validity duration**: Cursors may become invalid after extended periods

## Cursor Behavior Under Mutations

### Item Inserted
- If inserted BEFORE cursor position: May cause duplicate in next page
- If inserted AFTER cursor position: Will appear normally
- If inserted AT cursor position: Behavior depends on tie-breaking

### Item Deleted
- If deleted item was cursor: Next fetch continues from next item
- If deleted BEFORE cursor: May cause item to be skipped
- If deleted AFTER cursor: No effect on pagination

### Item Updated (Affecting Sort Order)
- Item may move to different page
- May cause apparent duplicate or skip
- This is expected behavior, not a bug

## Mitigation Strategies

For applications requiring consistency:
1. **Timestamp filtering**: Add `createdAt < snapshot_time` filter
2. **Optimistic locking**: Use ETags to detect concurrent modifications (see [etag.md](./etag.md))
3. **Sequence numbers**: Track changelog sequence for consistent views

## Test Coverage

- `tests/invariants/pagination-invariants.test.ts` - Core invariants
- `tests/pagination.test.ts` - Basic functionality
- `tests/smoke/pagination-cursor-hardening.test.ts` - Edge cases
