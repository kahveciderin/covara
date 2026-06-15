---
id: rsql
title: RSQL
sidebar_label: RSQL
description: Covara's RSQL expression language — the one syntax used for query filters and authorization scopes — its operators, combinators, value types, the type-safe TypeScript builder (rsql tag + helpers), and custom operators.
---

# RSQL

RSQL is the single expression language Covara uses everywhere it needs a predicate: the `?filter=` [query parameter](#as-a-query-filter), [authorization scopes](#in-authorization-scopes), subscription matching, aggregations, and batch operations. One string is compiled to **Drizzle SQL** for the database *and* executed **in-memory** for live subscription matching, so a filter behaves identically as a query and as a subscription.

```bash
GET /api/users?filter=status=="active";age>18
```

```typescript
// the same predicate, built safely in TypeScript:
rsql`status==${"active"};age>${18}`
```

This page is the full reference: the [language](#the-language), the [operators](#operator-reference), the [TypeScript builder](#building-rsql-in-typescript), and its two uses — [query filters](#as-a-query-filter) and [scopes](#in-authorization-scopes).

## The language

### Comparison

```
field==value        field!=value
field>value         field>=value
field<value         field<=value
```

Symbolic and named operators are equivalent:

| Symbolic | Named | Meaning |
|----------|-------|---------|
| `>` | `=gt=` | greater than |
| `>=` | `=ge=` | greater than or equal |
| `<` | `=lt=` | less than |
| `<=` | `=le=` | less than or equal |

### Combinators & grouping

| Combinator | Meaning | Forms |
|------------|---------|-------|
| AND | both hold | `;` · `&&` · `and` |
| OR | either holds | `,` · `\|\|` · `or` |
| Group | precedence | `( … )` |

```
status=="active";age>18
role=="admin",role=="moderator"
(status=="active";age>18),(role=="admin")
```

### Sets, ranges, strings, null, booleans

```
field=in=(a,b,c)        field=out=(a,b,c)        # set membership
field=between=[18,65]   field=nbetween=[0,17]    # range (inclusive); [..] or (..)
field%="pat"  field!%="pat"  field=ilike="pat"   # LIKE / NOT LIKE / case-insensitive
field=contains="t"  field=startswith="t"  field=endswith="t"   # (+ i-prefixed variants)
field=regex="^a"  field=iregex="^a"             # regex (in-memory uses JS RegExp)
field=length=N  field=minlength=N  field=maxlength=N
field=isnull=true   field=isempty=true          # null / null-or-empty checks
field==true   field==false                      # matches true/1/"true" and false/0/"false"
```

`%` matches any sequence, `_` a single character. ISO-8601 date strings are auto-detected and parsed (`createdAt>"2024-01-15"`).

### Value types & escaping

```
name=="John Doe"             # strings (quoted)
age==25   price==19.99       # numbers (unquoted)
active==true                 # booleans
deletedAt==null              # null
tags=in=("tech","news")      # sets
name=="John \"Johnny\" Doe"  # escape quotes inside strings
path=="C:\\Users\\John"      # escape backslashes
```

When you build RSQL in code, the [builder](#building-rsql-in-typescript) handles all of this escaping for you.

## Operator reference

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equals | `status=="active"` |
| `!=` | Not equals | `status!="deleted"` |
| `>`, `=gt=` | Greater than | `age>18` |
| `>=`, `=ge=` | Greater than or equal | `age>=18` |
| `<`, `=lt=` | Less than | `age<65` |
| `<=`, `=le=` | Less than or equal | `age<=65` |
| `=in=` | In list | `role=in=("a","b")` |
| `=out=` | Not in list | `role=out=("x","y")` |
| `%=` | LIKE | `name%="%john%"` |
| `!%=` | NOT LIKE | `name!%="%test%"` |
| `=ilike=` | Case-insensitive LIKE | `name=ilike="%john%"` |
| `=nilike=` | Case-insensitive NOT LIKE | `name=nilike="%test%"` |
| `=contains=` | Contains substring | `name=contains="john"` |
| `=icontains=` | Case-insensitive contains | `name=icontains="john"` |
| `=startswith=` | Starts with | `name=startswith="Dr."` |
| `=istartswith=` | Case-insensitive starts with | `name=istartswith="dr."` |
| `=endswith=` | Ends with | `email=endswith=".com"` |
| `=iendswith=` | Case-insensitive ends with | `email=iendswith=".COM"` |
| `=ieq=` | Case-insensitive equals | `status=ieq="ACTIVE"` |
| `=ine=` | Case-insensitive not equals | `status=ine="deleted"` |
| `=isnull=` | Is null | `deletedAt=isnull=true` |
| `=isempty=` | Null or empty string | `bio=isempty=true` |
| `=between=` | In range (inclusive) | `age=between=[18,65]` |
| `=nbetween=` | Not in range | `age=nbetween=[0,17]` |
| `=regex=` | Regex match | `email=regex="^admin@"` |
| `=iregex=` | Case-insensitive regex | `name=iregex="^john"` |
| `=length=` | Exact string length | `code=length=6` |
| `=minlength=` | Minimum string length | `password=minlength=8` |
| `=maxlength=` | Maximum string length | `username=maxlength=20` |

## Building RSQL in TypeScript

Instead of concatenating strings, build expressions with the `rsql` tag and helpers (exported from `covara` and `covara/auth`). Every value is **escaped**, so dynamic input can't break out of the expression or inject operators. Each builder returns a `CompiledScope`.

### The `rsql` tag

Static text is the expression; interpolated values are escaped by type.

```typescript
import { rsql } from "covara";

rsql`authorId==${user.id}`;            // authorId=="user-123"
rsql`age=ge=${18};role=in=${roles}`;   // age=ge=18;role=in=("admin","user")
rsql`name=contains=${query}`;          // any operator works — it's the full language
```

| Interpolated value | Becomes |
|--------------------|---------|
| string | quoted, with `"` `'` `\` escaped |
| number / boolean | raw |
| `Date` | quoted ISO 8601 |
| array | parenthesized list — `("a","b")` |
| `null` / `undefined` | `null` |
| `CompiledScope` | parenthesized sub-expression — see [composition](#composing-expressions) |

:::warning Values are escaped; field names and operators are not
Only interpolated **values** are escaped. The static template text — field names and operators — is trusted code. Never build a template's field names/operators from untrusted input.
:::

### Comparison helpers

For computed fields/operators, the helpers read better than a template:

| Helper | Emits | | Helper | Emits |
|--------|-------|---|--------|-------|
| `eq(f, v)` | `f==v` | | `inList(f, vs)` | `f=in=(…)` |
| `ne(f, v)` | `f!=v` | | `notIn(f, vs)` | `f=out=(…)` |
| `gt` / `gte` | `f=gt=v` / `f=ge=v` | | `like(f, p)` | `f%=p` |
| `lt` / `lte` | `f=lt=v` / `f=le=v` | | `notLike(f, p)` | `f!%=p` |
| `isNull(f)` | `f=isnull=true` | | `isNotNull(f)` | `f=isnull=false` |

```typescript
import { eq, gte, inList, like } from "covara";

eq("status", "active");              // status=="active"
inList("role", ["admin", "editor"]); // role=in=("admin","editor")
like("email", "%@acme.com");         // email%="%@acme.com"
```

:::note No `NOT` combinator
The grammar has no `NOT`, so there's no `not()` helper — use the negated operators: `ne`, `notIn`, `notLike`, `isNotNull`.
:::

### Combinators

```typescript
import { and, or, eq, gt } from "covara";

and(eq("status", "active"), gt("age", 18));   // (status=="active");(age=gt=18)
or(eq("role", "admin"), eq("role", "owner")); // (role=="admin"),(role=="owner")

eq("status", "active").and(gt("age", 18));    // fluent form on any CompiledScope
```

`and`/`or` **drop empty scopes**, so conditional pieces compose cleanly:

```typescript
and(eq("orgId", orgId), isAdmin ? emptyScope() : eq("ownerId", userId));
// admins → orgId=="…"; everyone else → (orgId=="…");(ownerId=="…")
```

### Composing expressions

A `CompiledScope` interpolated into a template embeds as a **parenthesized sub-expression** (not a quoted string), so expressions compose — including nested `rsql` calls:

```typescript
const mine = eq("authorId", user.id);
rsql`published==${true};${mine}`;                       // published==true;(authorId=="user-123")
rsql`status==${"active"};${rsql`tier=in=${["pro"]}`}`;  // status=="active";(tier=in=("pro"))
```

`` rsql`${a};${b}` `` is exactly `and(a, b)`.

:::tip Empty scopes in templates
`and`/`or` skip empties, but a raw template can't — `` rsql`a==1;${emptyScope()}` `` yields the dangling `a==1;()`. Use the combinators when a piece may be empty.
:::

### Special expressions

| Builder | Expression | Meaning |
|---------|-----------|---------|
| `allScope()` | `*` | match everything (no restriction) |
| `emptyScope()` | *(empty)* | match nothing (deny) |

### Utilities & the `CompiledScope` type

```typescript
import { scopeFromString, isCompiledScope } from "covara";

scopeFromString('status=="active"'); // wrap a raw RSQL string
isCompiledScope(value);              // runtime type guard
```

```typescript
interface CompiledScope {
  toString(): string;   // the RSQL expression
  isEmpty(): boolean;
  and(other: CompiledScope): CompiledScope;
  or(other: CompiledScope): CompiledScope;
}
```

## As a query filter

The most common use: filtering reads. Send a filter string on any list/count/aggregate/search endpoint; subscriptions apply it to the live stream too.

**HTTP**

```bash
GET /api/users?filter=status=="active";age>18
```

**Client** — pass a string, or build it with the [query builder](../client/queries.md) (which escapes for you):

```typescript
import { rsql } from "covara";

client.resources.users.filter('status=="active";age>18').list();
client.resources.users.filter(rsql`status==${status};age>${minAge}`).list();

useLiveList("/api/users", { filter: 'status=="active"' }); // React
```

Restrict which columns may be filtered with [`fields.filterable`](./fields.md) — a filter on a non-allowed column returns `400 FilterParseError`.

## In authorization scopes

A [scope](../auth/scopes.md) is just an RSQL expression returned per operation; the framework combines it with the request filter so a user can only ever see/act on rows their scope allows. Build scopes with the same `rsql` tag and helpers:

```typescript
useResource(posts, {
  db, id: posts.id,
  auth: {
    read: async (user) =>
      user?.role === "admin" ? allScope() : rsql`authorId==${user?.id};published==${true}`,
    update: async (user) => (user ? eq("authorId", user.id) : emptyScope()),
  },
});
```

`combineScopes(scope, filter?)` merges a scope with an incoming `?filter=` (the basis of [secure queries](../auth/secure-queries.md)) — `*` adds no restriction, an empty scope denies:

```typescript
import { combineScopes } from "covara";
combineScopes(eq("ownerId", user.id), 'status=="archived"');
// (ownerId=="user-123");(status=="archived")
```

See [Authorization scopes](../auth/scopes.md) for how scopes are resolved and enforced (including the higher-level [`scopePatterns`](../auth/scopes.md#scope-patterns)).

## Custom operators

Define operators with a SQL `convert` (for queries) and a JS `execute` (for subscription matching) so query and live behavior stay consistent.

```typescript
import { sql } from "drizzle-orm";

useResource(usersTable, {
  id: usersTable.id,
  db,
  customOperators: {
    "=jsoncontains=": {
      convert: (lhs, rhs) => sql`JSON_CONTAINS(${lhs}, ${rhs})`,
      execute: (lhs, rhs) => JSON.parse(String(lhs)).includes(rhs),
    },
  },
});
```

```bash
GET /api/users?filter=permissions=jsoncontains="write"
```

## Best practices

- **Always interpolate dynamic values** through the `rsql` tag or helpers — never string-concatenate user input. Escaping is what makes filters and scopes injection-safe.
- **Template for readability, helpers for dynamics** — `` rsql`ownerId==${id}` `` for fixed shapes; `eq`/`and`/`or` when fields/operators/membership are computed.
- **`allScope()` / `emptyScope()` for the extremes** — grant unrestricted access or deny, instead of inventing always-true/false expressions.
- **Keep query and subscription behavior identical** — when adding a custom operator, always provide both `convert` and `execute`.

## Related

- [Filtering](./filtering.md) — applying filters to query endpoints
- [Authorization scopes](../auth/scopes.md) · [Secure queries](../auth/secure-queries.md)
- [Fields](./fields.md) — `filterable`/`sortable` allowlists · [Subscriptions](../realtime/subscriptions.md)
