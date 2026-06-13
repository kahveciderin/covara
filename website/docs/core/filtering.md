---
id: filtering
title: Filtering (RSQL)
sidebar_label: Filtering
description: Covara's RSQL-like filter language — 30+ built-in operators, combinators, date handling, and custom operators that work for both SQL queries and live subscription matching.
---

# Filtering

Covara uses an RSQL-like syntax for the `filter` query parameter. The same filter string is compiled to **Drizzle SQL** for database queries and executed **in-memory** for subscription matching, so a subscription's filter always behaves identically to the equivalent list query.

```bash
GET /api/users?filter=status=="active";age>18
```

## Basic syntax

```
field==value        # Equals
field!=value        # Not equals
field>value         # Greater than
field>=value        # Greater than or equal
field<value         # Less than
field<=value        # Less than or equal
```

Both symbolic and named comparison operators are supported and equivalent:

| Symbolic | Named | Description |
|----------|-------|-------------|
| `>` | `=gt=` | Greater than |
| `>=` | `=ge=` | Greater than or equal |
| `<` | `=lt=` | Less than |
| `<=` | `=le=` | Less than or equal |

```bash
GET /api/users?filter=age>18      # equivalent to:
GET /api/users?filter=age=gt=18
```

## Combinators

| Combinator | Meaning | Forms |
|------------|---------|-------|
| AND | both must hold | `;` · `&&` · `and` |
| OR | either holds | `,` · `\|\|` · `or` |
| Grouping | precedence | `( ... )` |

```
status=="active";age>18
status=="active" && age>18
role=="admin",role=="moderator"
(status=="active";age>18),(role=="admin")
```

## Set membership

```
field=in=(a,b,c)    # value is in the list
field=out=(a,b,c)   # value is not in the list
```

```bash
GET /api/users?filter=role=in=("admin","moderator")
GET /api/users?filter=status=out=("deleted","banned")
```

## Range / between

Both `[...]` and `(...)` forms work:

```bash
GET /api/users?filter=age=between=[18,65]
GET /api/products?filter=price=between=(10,100)
GET /api/events?filter=date=between=["2024-01-01","2024-12-31"]
GET /api/users?filter=age=nbetween=[0,17]
```

## String operations

### Pattern matching (LIKE)

```
field%="pattern"        # LIKE (case-sensitive)
field!%="pattern"       # NOT LIKE
field=ilike="pattern"   # case-insensitive LIKE
field=nilike="pattern"  # case-insensitive NOT LIKE
```

SQL wildcards: `%` matches any sequence, `_` matches a single character.

```bash
GET /api/users?filter=email%="%@gmail.com"
GET /api/users?filter=name=ilike="%john%"
```

### Substring / prefix / suffix

```
field=contains="text"     field=icontains="text"
field=startswith="text"   field=istartswith="text"
field=endswith="text"     field=iendswith="text"
```

```bash
GET /api/users?filter=name=contains="Smith"
GET /api/users?filter=email=iendswith="@company.com"
```

### Case-insensitive equality

```
field=ieq="value"   # case-insensitive equals
field=ine="value"   # case-insensitive not equals
```

### Regular expressions

```
field=regex="pattern"    field=iregex="pattern"
```

```bash
GET /api/users?filter=email=regex="^admin@"
```

Regex support varies by database; in-memory subscription matching uses JavaScript `RegExp`.

### Length checks

```
field=length=N       field=minlength=N       field=maxlength=N
```

## Null and empty checks

```
field=isnull=true    # is null
field=isnull=false   # is not null
field=isempty=true   # null or empty string
field=isempty=false  # has a non-empty value
```

## Boolean comparisons

Booleans are matched intelligently, handling databases that store them as 0/1:

```
field==true    # matches true, 1, "true", "1"
field==false   # matches false, 0, "false", "0"
field!=true    # matches anything not truthy
```

```bash
GET /api/users?filter=isActive==true
```

## Dates

ISO 8601 strings are auto-detected and parsed:

```bash
GET /api/posts?filter=createdAt>"2024-01-15T10:30:00.000Z"
GET /api/posts?filter=createdAt>="2024-01-15"
GET /api/posts?filter=createdAt>="2024-01-01";createdAt<"2024-02-01"
GET /api/events?filter=startDate=between=["2024-06-01","2024-06-30"]
```

## Value types & escaping

```
name=="John Doe"             # strings (quoted)
age==25  price==19.99        # numbers (unquoted)
active==true                 # booleans
deletedAt==null              # null
tags=in=("tech","news")      # sets
age=between=[18,65]          # ranges
name=="John \"Johnny\" Doe"  # escape quotes inside strings
path=="C:\\Users\\John"      # escape backslashes
```

## Complete operator reference

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

## Custom operators

Define operators with both a SQL `convert` (for queries) and a JS `execute` (for subscription matching). Providing both keeps query and subscription behavior consistent.

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

## Filterable allowlist

To restrict which columns may be filtered, set [`fields.filterable`](./fields.md). A filter referencing a non-allowed column returns a `400 FilterParseError`.

## Related

- [Fields](./fields.md) — `filterable`/`sortable` allowlists
- [Subscriptions](../realtime/subscriptions.md) — filters scope the live stream
- [Authorization scopes](../auth/scopes.md) — scopes are RSQL filters combined with the request filter
