---
id: secure-queries
title: Secure query builder
sidebar_label: Secure queries
description: The scope-enforcement layer behind useResource — run scope-safe selects, counts, aggregates, and mutations in your own routes, with admin bypass and audit logging.
---

# Secure query builder

The secure query builder is the layer `useResource` uses to enforce [authorization scopes](./scopes.md) on every read, count, aggregate, and mutation. You can also use it directly in custom routes when you need scope-safe database access.

`createScopeResolver` and `createResourceFilter` are exported from `covara`; the builder factory lives in `src/resource/secure-query.ts`.

```typescript
import { createScopeResolver, createResourceFilter, getUser } from "covara";
import { createSecureQueryBuilder } from "@/resource/secure-query";

const scopeResolver = createScopeResolver(config.auth);
const filterer = createResourceFilter(postsTable);

app.get("/api/my-posts", async (c) => {
  const builder = createSecureQueryBuilder(postsTable, db, scopeResolver, filterer, { user: getUser(c) });
  const posts = await builder.executeSelect("published==true", { limit: 10 });
  return c.json(posts);
});
```

## Methods

| Method | Description |
|--------|-------------|
| `executeSelect(filter?, opts?)` | Scoped select. `opts`: `limit`, `offset`, `orderBy`, `cursorCondition`. |
| `executeCount(filter?)` | Scoped count. |
| `executeAggregate(params, filter?)` | Scoped [aggregation](../core/aggregations.md). |
| `select(filter?)` | Build the scoped Drizzle `SQL` WHERE without executing. |
| `selectWithScope(op, filter?)` | Resolve the scope for a specific operation (`"read"`/`"update"`/`"delete"`). |

```typescript
const results = await builder.executeSelect('status=="active";createdAt>"2024-01-01"', { limit: 20 });
const count = await builder.executeCount('status=="published"');
const stats = await builder.executeAggregate({ groupBy: ["category"], count: true, avg: ["views"] });
```

The user's scope is always applied, so a query can only narrow within it:

```typescript
// auth.read scope: rsql`userId=="${user.id}"`
await builder.executeSelect('status=="draft"');
// → SELECT * FROM posts WHERE status = 'draft' AND userId = 'user123'
```

## Scoped mutations

```typescript
import { createSecureMutationBuilder } from "@/resource/secure-query";

const mutations = createSecureMutationBuilder(postsTable, db, scopeResolver, filterer, { user: getUser(c) });

const updateFilter = await builder.selectWithScope("update", 'category=="draft"');
await mutations.update(updateFilter, { status: "published" });

const deleteFilter = await builder.selectWithScope("delete", 'createdAt<"2023-01-01"');
await mutations.delete(deleteFilter);
```

## Admin bypass with audit logging

```typescript
const adminBuilder = builder.asAdmin("Admin data export");
const everything = await adminBuilder.executeSelect();
// logs: { level: "warn", type: "admin_scope_bypass", reason: "Admin data export", ... }

import { getAdminAuditLog, clearAdminAuditLog } from "@/resource/secure-query";
const entries = getAdminAuditLog(); // [{ reason, timestamp, userId }]
```

## Field-level write enforcement

Separately from scope filters, [`fields.writable`](../core/fields.md) is an enforced allowlist of columns a client may set, stripping protected columns (e.g. `ownerId`, `role`) from inbound bodies before hooks or the database see them — mass-assignment protection. See [Fields](../core/fields.md#write-enforcement-fieldswritable-mass-assignment-protection).

## Type safety

```typescript
const posts = await builder.executeSelect<Post>();
posts[0].title; // string
```

## Related

- [Authorization scopes](./scopes.md) · [Fields & masking](../core/fields.md) · [Filtering](../core/filtering.md)
- [Auth contract](../contracts/auth.md)
