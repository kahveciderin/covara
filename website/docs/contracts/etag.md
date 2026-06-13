# ETag / Optimistic Concurrency Contracts

These guarantees apply to resources configured with `etag` in `useResource(table, { etag: {...} })`. Without the config, no ETag headers are emitted and conditional headers are ignored.

## Guarantees

### ETag Emission
- **Mutating and single-item responses carry ETags**: `POST /`, `GET /:id`, `PATCH /:id`, and `PUT /:id` responses include an `ETag` header reflecting the returned representation
- **Tag derivation precedence**: `versionField` (if set and present on the item) → `updatedAtField` + `idField` (timestamp-id pair) → MD5 hash of the serialized item
- **Weak by default**: Tags are weak (`W/"..."`) unless `algorithm: "strong"` is configured
- **Deterministic**: The same item state always produces the same ETag

### Conditional Writes (If-Match)
- **Enforcement on mutation**: `If-Match` is checked against the *current* stored item on `PATCH /:id`, `PUT /:id`, and `DELETE /:id` before the mutation executes
- **412 on mismatch**: A non-matching `If-Match` fails with `412 Precondition Failed` (`PRECONDITION_FAILED`, RFC 7807 body including `currentETag` in details) and the mutation is not applied
- **Compare-and-swap**: When `If-Match` is present, the `PATCH`/`PUT`/`DELETE` statement carries a CAS predicate on the version/updated-at field, so the validated version must still match at write time. If a concurrent writer changed the row between the read and the write, zero rows match and the request fails with `412` instead of silently losing the update — exactly one of N concurrent `If-Match` writers wins, the rest get `412`
- **Wildcard**: `If-Match: *` matches any current state (the write proceeds if the item exists)
- **Multiple tags**: `If-Match` may contain a comma-separated list; the check passes if any tag matches
- **Strong comparison (RFC 7232 §3.1)**: `If-Match` uses the strong comparison function
- **No header, no check**: Requests without `If-Match` are unconditional (last write wins, no CAS predicate)

### Conditional Reads (If-None-Match)
- **304 on match**: `GET /:id` with a matching `If-None-Match` returns `304 Not Modified` with an empty body and the current `ETag` header
- **Fresh data otherwise**: A non-matching tag returns `200` with the full representation and current `ETag`

### Version Auto-Increment (Optimistic Locking)
- **Increment on every update**: When `versionField` is configured, the field is incremented by 1 on every `PATCH /:id` and `PUT /:id`, starting from the current stored value (missing/non-numeric values are left untouched)
- **Client override**: If the request body explicitly sets the version field, that value is used instead of auto-increment
- **Lost-update protection**: Two clients that read version N and both write with `If-Match` — the CAS predicate guarantees exactly one write lands; the other matches zero rows and receives 412 and must refetch

## Non-Guarantees

- ❌ **List ETags**: `GET /` (list) responses do not carry per-item ETags
- ❌ **Batch conditional writes**: `If-Match` is not enforced on `/batch` operations, and batch updates do not auto-increment the version field
- ❌ **CAS without a comparison field**: The compare-and-swap predicate requires a `versionField` or `updatedAtField`. With neither configured (hash-only ETags), the If-Match check is still enforced before the write but is not atomic with it, so an interleaving writer could theoretically slip between check and write
- ❌ **Hash stability across versions**: The fallback (hash-based) tag format may change between minor versions; treat ETags as opaque
- ❌ **Strong validator semantics**: Weak tags (default) do not guarantee byte-for-byte identity of representations

## Failure Modes

### If-Match Mismatch
- Returns `412` with problem details: `code: "PRECONDITION_FAILED"`, `details.currentETag` set to the item's current tag, and a suggestion to refetch
- The stored item is unchanged

### Malformed ETag in Header
- Tags that are not `"value"` or `W/"value"` never match → conditional writes fail with 412, conditional reads return 200

### Item Not Found
- Conditional requests against a missing id return `404` (the conditional check is not reached)

## Test Coverage

- `tests/concurrency/etag-race.test.ts` - ETag emission, If-Match enforcement, `*` wildcard, concurrent optimistic locking, delete
