# Aggregations

Covara supports powerful aggregation queries for analytics, dashboards, and reporting. Query aggregate statistics with optional grouping.

## Basic Usage

### Server-side

Aggregations are automatically enabled on all resources at the `/aggregate` endpoint.

### Client-side

```typescript
const users = client.resource<User>("/users");

// Simple count
const result = await users.aggregate({ count: true });
console.log(result.groups[0].count); // e.g., 1234

// With grouping
const byRole = await users.aggregate({
  groupBy: ["role"],
  count: true,
});
// [{ key: { role: "admin" }, count: 5 }, { key: { role: "user" }, count: 95 }]
```

## Aggregation Functions

| Function | Description | Example |
|----------|-------------|---------|
| `count` | Count of records | `count: true` |
| `sum` | Sum of numeric field | `sum: ["salary"]` |
| `avg` | Average of numeric field | `avg: ["age"]` |
| `min` | Minimum value | `min: ["createdAt"]` |
| `max` | Maximum value | `max: ["price"]` |

## Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `groupBy` | string[] | Fields to group by |
| `count` | boolean | Include count |
| `sum` | string[] | Fields to sum |
| `avg` | string[] | Fields to average |
| `min` | string[] | Fields to find minimum |
| `max` | string[] | Fields to find maximum |
| `filter` | string | RSQL filter expression (applied before grouping) |
| `having` | string | Filter groups by aggregate output (applied after grouping) |

## Response Format

```typescript
interface AggregationResponse {
  groups: AggregationGroup[];
}

interface AggregationGroup {
  key: Record<string, unknown> | null;  // null if no groupBy
  count?: number;
  sum?: Record<string, number>;
  avg?: Record<string, number>;
  min?: Record<string, number | string>;
  max?: Record<string, number | string>;
}
```

## Examples

### Count All Records

```typescript
const result = await users.aggregate({ count: true });
// { groups: [{ key: null, count: 1234 }] }
```

### Group By Single Field

```typescript
const byRole = await users.aggregate({
  groupBy: ["role"],
  count: true,
});
// {
//   groups: [
//     { key: { role: "admin" }, count: 5 },
//     { key: { role: "user" }, count: 95 },
//     { key: { role: "guest" }, count: 50 }
//   ]
// }
```

### Group By Multiple Fields

```typescript
const byRoleAndStatus = await users.aggregate({
  groupBy: ["role", "status"],
  count: true,
});
// {
//   groups: [
//     { key: { role: "admin", status: "active" }, count: 4 },
//     { key: { role: "admin", status: "inactive" }, count: 1 },
//     { key: { role: "user", status: "active" }, count: 80 },
//     ...
//   ]
// }
```

### Statistical Aggregations

```typescript
const stats = await orders.aggregate({
  groupBy: ["category"],
  count: true,
  sum: ["total", "quantity"],
  avg: ["total"],
  min: ["total"],
  max: ["total"],
});
// {
//   groups: [
//     {
//       key: { category: "electronics" },
//       count: 150,
//       sum: { total: 75000, quantity: 200 },
//       avg: { total: 500 },
//       min: { total: 50 },
//       max: { total: 2500 }
//     },
//     ...
//   ]
// }
```

### With Filtering

```typescript
// Aggregate only active users
const activeStats = await users.aggregate({
  filter: 'status=="active"',
  groupBy: ["department"],
  count: true,
  avg: ["salary"],
});

// Aggregate orders from this month
const monthlyStats = await orders.aggregate({
  filter: 'createdAt>="2024-01-01"',
  groupBy: ["status"],
  count: true,
  sum: ["total"],
});
```

### Filtering Groups with HAVING

`filter` narrows the rows **before** grouping; `having` filters the resulting **groups** by their
aggregate output. Use the `having` query parameter with comparisons joined by `;` (AND):

```bash
# Categories with at least 5 orders AND total revenue over 100
curl "http://localhost:3000/api/orders/aggregate?groupBy=category&count=true&sum=total&having=count>=5;sum_total>100"
```

The fields referenced in `having` are the **aggregate output aliases**:

| Alias | Produced by |
|-------|-------------|
| `count` | `count=true` |
| `sum_<field>` | `sum=<field>` |
| `avg_<field>` | `avg=<field>` |
| `min_<field>` | `min=<field>` |
| `max_<field>` | `max=<field>` |
| `<field>` | a `groupBy` column |

Supported operators: `==`, `!=`, `>`, `>=`, `<`, `<=`. An alias referenced in `having` must be
present in the query's selections (e.g. `sum_total` requires `sum=total`); referencing an unknown
alias returns a `400` validation error. Numeric right-hand values are compared numerically;
non-numeric values are compared as strings.

```bash
# Group by status, keep only groups whose average total exceeds 500
curl "http://localhost:3000/api/orders/aggregate?groupBy=status&avg=total&having=avg_total>500"
```

> The HTTP query parameter is the supported interface for `having`; the typed client
> `aggregate()` helper does not yet expose it.

### Date-based Aggregations

For time-series data, you can use computed fields or pre-aggregated tables:

```typescript
// Group by date (requires date field)
const dailyOrders = await orders.aggregate({
  groupBy: ["orderDate"],
  count: true,
  sum: ["total"],
});
```

## HTTP Examples

```bash
# Simple count
curl "http://localhost:3000/api/users/aggregate?count=true"

# Group by role
curl "http://localhost:3000/api/users/aggregate?groupBy=role&count=true"

# Multiple aggregations
curl "http://localhost:3000/api/orders/aggregate?groupBy=category&count=true&sum=total&avg=total"

# With filter
curl "http://localhost:3000/api/orders/aggregate?filter=status==%22completed%22&groupBy=category&sum=total"
```

## Dashboard Example

Build a complete dashboard with aggregations:

```typescript
async function getDashboardStats() {
  const users = client.resource<User>("/users");
  const orders = client.resource<Order>("/orders");

  const [
    usersByRole,
    ordersByStatus,
    revenueByCategory,
    dailyStats
  ] = await Promise.all([
    // Users by role
    users.aggregate({
      groupBy: ["role"],
      count: true,
    }),

    // Orders by status
    orders.aggregate({
      groupBy: ["status"],
      count: true,
    }),

    // Revenue by category
    orders.aggregate({
      filter: 'status=="completed"',
      groupBy: ["category"],
      sum: ["total"],
      count: true,
    }),

    // Overall stats
    orders.aggregate({
      filter: 'createdAt>="2024-01-01"',
      count: true,
      sum: ["total"],
      avg: ["total"],
    }),
  ]);

  return {
    usersByRole: usersByRole.groups,
    ordersByStatus: ordersByStatus.groups,
    revenueByCategory: revenueByCategory.groups,
    totalOrders: dailyStats.groups[0].count,
    totalRevenue: dailyStats.groups[0].sum?.total,
    avgOrderValue: dailyStats.groups[0].avg?.total,
  };
}
```

## Live Aggregations (Subscriptions)

Every resource also exposes `GET /aggregate/subscribe`, an SSE endpoint that
streams the aggregate result and **recomputes + re-emits it whenever the
resource is mutated**. The result is recomputed from the database, so it stays
exact for any `groupBy`/`having` combination — there is no incremental-aggregation
drift.

### React

```tsx
import { useLiveAggregate } from "covara/client/react";

function TodoStats() {
  const { groups, isLive } = useLiveAggregate("/api/todos", {
    groupBy: ["completed"],
    count: true,
  });

  const completed = groups.find((g) => g.key?.completed)?.count ?? 0;
  return <div>{completed} completed {isLive ? "🟢" : "…"}</div>;
}
```

### Imperative client

```typescript
const todos = client.resource<Todo>("/api/todos");

const sub = todos.subscribeAggregate(
  { groupBy: ["status"], count: true, sum: ["amount"] },
  {
    onData: (result) => console.log(result.groups),
    onConnectionChange: (connected) => console.log("live:", connected),
  }
);

// later
sub.unsubscribe();
```

### Semantics

- On connect the server emits `connected` then one `aggregate` event with the
  current snapshot (even when the resource is empty).
- **Scope-aware**: a subscription only recomputes when a mutated row could be in
  its scope. Each subscription carries its compiled read scope + `filter` and is
  handed the changed rows — the new row for inserts, new **and** previous state
  for updates, and the deleted rows' prior content for deletes — so a per-user
  aggregate like `userId==<me>` does **not** recompute on other users' inserts,
  updates, or deletes. This is what keeps the cost bounded with many concurrent
  per-user subscriptions. Unscoped/global aggregates always recompute.
- Raw-SQL/external invalidations and cross-process notifications fall back to an
  unconditional recompute (row data isn't shipped over pub/sub). Skipping is only
  applied when provably safe — the result dedup below is the correctness backstop,
  so over-recomputing never produces a wrong result.
- Bursts of mutations coalesce into a single recompute (`sse.aggregateDebounceMs`,
  default 150ms). An event is suppressed when the recomputed result matches the
  previous one under an order-independent comparison (group order is normalized,
  since `GROUP BY` has no stable `ORDER BY`).
- In multi-process deployments, mutations fan out to watchers via the KV pub/sub
  channel (the same KV that powers row subscriptions).
- The read scope and `filter` are resolved once at connect and reused for the life
  of the connection. Aggregate subscriptions do not support `resumeFrom`/catchup —
  a reconnect simply re-emits the current snapshot.

See [Subscriptions](subscriptions.md) for the underlying SSE transport and
reconnection behavior.

## Best Practices

1. **Use filters** to limit the dataset before aggregating
2. **Index group-by fields** for better performance
3. **Avoid too many groups** - consider limiting with filters
4. **Cache results** for expensive aggregations
5. **Use count judiciously** - it requires scanning all matching rows

## Performance Considerations

- Aggregations scan all matching rows
- Index fields used in `groupBy` and `filter` clauses
- For very large datasets, consider:
  - Pre-aggregated summary tables
  - Time-based partitioning
  - Background aggregation jobs
