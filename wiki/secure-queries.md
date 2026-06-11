# Secure Query Builder

The Secure Query Builder is the scope-enforcement layer used internally by `useResource`. Every list, get, count, aggregate, and mutation goes through it, so the authenticated user's scope is always applied. You can also use it directly in custom routes or procedures when you need scope-safe database access.

## Overview

When you define auth scopes on a resource, all queries automatically have the scope applied. The Secure Query Builder provides additional control for complex scenarios.

> Note: the builder lives in `src/resource/secure-query.ts` and is not part of the public package exports — scope enforcement happens automatically on every `useResource` endpoint. The API below documents the enforcement layer's behavior and guarantees; `createScopeResolver` and `createResourceFilter` are exported from `covara` if you need scoped SQL conditions in your own routes.

## Basic Usage

```typescript
import { createScopeResolver, createResourceFilter, getUser } from "covara";
import { createSecureQueryBuilder } from "@/resource/secure-query";

const scopeResolver = createScopeResolver(config.auth);
const filterer = createResourceFilter(postsTable);

app.get("/api/my-posts", async (c) => {
  const builder = createSecureQueryBuilder(postsTable, db, scopeResolver, filterer, {
    user: getUser(c),
  });

  // Scope is automatically combined with the additional RSQL filter
  const posts = await builder.executeSelect('published==true', { limit: 10 });
  return c.json(posts);
});
```

## API

### `executeSelect(additionalFilter?, options?)`

Find records with scope enforcement. The optional filter is an RSQL string; options support `limit`, `offset`, `orderBy`, and `cursorCondition`:

```typescript
const results = await builder.executeSelect(
  'status=="active";createdAt>"2024-01-01"',
  { limit: 20, offset: 0 }
);
```

### `executeCount(additionalFilter?)`

Count matching records:

```typescript
const count = await builder.executeCount('status=="published"');
```

### `executeAggregate(params, additionalFilter?)`

Aggregation queries:

```typescript
const stats = await builder.executeAggregate({
  groupBy: ["category"],
  count: true,
  avg: ["views"],
});
// { groups: [{ key: { category: "..." }, count: 12, avg: { views: 340 } }, ...] }
```

### `select(additionalFilter?)` / `selectWithScope(operation, additionalFilter?)`

Build the scoped Drizzle `SQL` WHERE condition without executing, for use in custom queries. `selectWithScope` resolves the scope for a specific operation (`"read"`, `"update"`, `"delete"`, ...).

## Scope Enforcement

The builder always applies the user's scope, preventing unauthorized data access:

```typescript
// auth.read scope: rsql`userId=="${user.id}"` — only own posts

// This query is safe - scope is automatically applied
const allPosts = await builder.executeSelect('status=="draft"');
// SQL: SELECT * FROM posts WHERE status = 'draft' AND userId = 'user123'
```

## Admin Bypass

For admin operations, you can bypass scope with audit logging:

```typescript
const adminBuilder = builder.asAdmin("Admin data export");
const everything = await adminBuilder.executeSelect();

// Logs: {"level":"warn","type":"admin_scope_bypass","reason":"Admin data export",...}
```

All bypasses are recorded in an in-memory audit log:

```typescript
import { getAdminAuditLog, clearAdminAuditLog } from "@/resource/secure-query";

const entries = getAdminAuditLog();  // [{ reason, timestamp, userId }]
```

## Mutations

`createSecureMutationBuilder` provides scope-aware mutations. The `update` and `delete` methods take a scoped filter (built via the query builder) so they only affect records within scope:

```typescript
import { createSecureMutationBuilder } from "@/resource/secure-query";

const mutations = createSecureMutationBuilder(postsTable, db, scopeResolver, filterer, {
  user: getUser(c),
});

const updateFilter = await builder.selectWithScope("update", 'category=="draft"');
await mutations.update(updateFilter, { status: "published" });

const deleteFilter = await builder.selectWithScope("delete", 'createdAt<"2023-01-01"');
await mutations.delete(deleteFilter);
```

## Field-level write enforcement

Separately from scope filters, `fields.writable` on a resource is an **enforced allowlist** of table
columns a client may set on create and update. Any table column not in the list is stripped from the
incoming body before hooks or the database see it, on every create/update path including
`POST /batch/upsert`. The primary key and `generatedFields` are exempt, and non-column keys (relation
payloads) pass through.

This is mass-assignment protection: even if a client posts `{ "ownerId": "victim", ... }`, the
`ownerId` field is dropped unless it appears in `fields.writable`. Stripping happens before lifecycle
hooks, so a server-side hook can still set protected fields itself. See
[Resources → Field-level write enforcement](./resources.md#field-level-write-enforcement-mass-assignment-protection)
and the [Authentication contract](../contracts/auth.md).

## Type Safety

Results are typed from your Drizzle schema:

```typescript
const posts = await builder.executeSelect<Post>();
posts[0].title;  // string
```

## Related

- [Authentication](./authentication.md) - Auth scopes configuration
- [Resources](./resources.md) - Resource setup
- [Filtering](./filtering.md) - Filter expressions
