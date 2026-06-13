---
id: aggregations
title: Aggregations
sidebar_label: Aggregations
description: Group-by, count, sum, avg, min, max queries with pre-grouping filters and post-grouping HAVING, plus a live aggregation subscription that recomputes on every change.
---

# Aggregations

Every resource exposes `GET /aggregate` for analytics-style queries — counts, sums, averages, and grouping — and `GET /aggregate/subscribe` for a [live version](../realtime/aggregate-subscriptions.md) that recomputes on every mutation.

## Functions

| Function | Parameter | Description |
|----------|-----------|-------------|
| `count` | `count=true` | Count of matching rows. |
| `sum` | `sum=field` | Sum of a numeric column. |
| `avg` | `avg=field` | Average of a numeric column. |
| `min` | `min=field` | Minimum value. |
| `max` | `max=field` | Maximum value. |

Multiple fields are comma-separated (`sum=total,quantity`).

## Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `groupBy` | string[] | Columns to group by (comma-separated). |
| `count` | boolean | Include a count. |
| `sum` / `avg` / `min` / `max` | string[] | Columns to aggregate. |
| `filter` | string | [RSQL filter](./filtering.md) applied **before** grouping. |
| `having` | string | Filter the resulting groups by their aggregate output. |

## Response shape

```typescript
interface AggregationResponse {
  groups: Array<{
    key: Record<string, unknown> | null; // null when no groupBy
    count?: number;
    sum?: Record<string, number>;
    avg?: Record<string, number>;
    min?: Record<string, number | string>;
    max?: Record<string, number | string>;
  }>;
}
```

## Examples

```bash
# Count everything
GET /api/users/aggregate?count=true
# → { "groups": [{ "key": null, "count": 1234 }] }

# Group by one column
GET /api/users/aggregate?groupBy=role&count=true
# → groups: [{ key: { role: "admin" }, count: 5 }, { key: { role: "user" }, count: 95 }]

# Group by multiple columns with stats
GET /api/orders/aggregate?groupBy=category&count=true&sum=total,quantity&avg=total&min=total&max=total

# Filter rows before aggregating
GET /api/orders/aggregate?filter=status=="completed"&groupBy=category&sum=total
```

Client:

```typescript
const orders = client.resource<Order>("/api/orders");
const byCategory = await orders.aggregate({
  groupBy: ["category"],
  count: true,
  sum: ["total"],
  avg: ["total"],
});
```

## Filtering groups with HAVING

`filter` narrows rows **before** grouping; `having` filters **groups** by their aggregate output, joined by `;` (AND).

```bash
# Categories with ≥5 orders AND revenue > 100
GET /api/orders/aggregate?groupBy=category&count=true&sum=total&having=count>=5;sum_total>100
```

`having` references the aggregate **output aliases**:

| Alias | Produced by |
|-------|-------------|
| `count` | `count=true` |
| `sum_<field>` | `sum=<field>` |
| `avg_<field>` | `avg=<field>` |
| `min_<field>` | `min=<field>` |
| `max_<field>` | `max=<field>` |
| `<field>` | a `groupBy` column |

Supported operators: `==`, `!=`, `>`, `>=`, `<`, `<=`. An alias used in `having` must be selected by the query (`sum_total` requires `sum=total`); referencing an unknown alias returns `400`. Numeric right-hand values compare numerically; otherwise as strings.

```bash
GET /api/orders/aggregate?groupBy=status&avg=total&having=avg_total>500
```

:::note
`having` is exposed through the HTTP query parameter. The typed client's `aggregate()` helper does not yet surface it.
:::

## Live aggregations

`GET /aggregate/subscribe` (and `useLiveAggregate` / `subscribeAggregate` on the client) streams the aggregate result and recomputes it whenever the resource is mutated. It is scope-aware, so per-user aggregates don't recompute for other users' changes. See **[Aggregate subscriptions](../realtime/aggregate-subscriptions.md)** for the full semantics.

```tsx
import { useLiveAggregate } from "covara/client/react";

function TodoStats() {
  const { groups, isLive } = useLiveAggregate("/api/todos", { groupBy: ["completed"], count: true });
  const completed = groups.find((g) => g.key?.completed)?.count ?? 0;
  return <div>{completed} completed {isLive ? "🟢" : "…"}</div>;
}
```

## Performance

- Aggregations scan all matching rows — index the columns used in `groupBy` and `filter`.
- For very large datasets consider pre-aggregated summary tables, time partitioning, or [background jobs](../platform/tasks.md).

## Related

- [Filtering](./filtering.md) · [Aggregate subscriptions](../realtime/aggregate-subscriptions.md)
- [Client queries](../client/queries.md) · [React hooks](../client/react-hooks.md)
