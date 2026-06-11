# Filtering

Covara uses an RSQL-like syntax for filtering resources. The filter system includes comprehensive built-in operators for common use cases, with support for custom operators when needed.

## Basic Syntax

```
field==value        # Equals
field!=value        # Not equals
field>value         # Greater than
field>=value        # Greater than or equal
field<value         # Less than
field<=value        # Less than or equal
```

## Comparison Operators

Both symbolic and named operators are supported:

| Symbolic | Named | Description |
|----------|-------|-------------|
| `>` | `=gt=` | Greater than |
| `>=` | `=ge=` | Greater than or equal |
| `<` | `=lt=` | Less than |
| `<=` | `=le=` | Less than or equal |
| `==` | | Equals |
| `!=` | | Not equals |

```bash
# These are equivalent:
GET /users?filter=age>18
GET /users?filter=age=gt=18
```

## Set Membership

```
field=in=(a,b,c)    # Value is in list
field=out=(a,b,c)   # Value is not in list
```

```bash
GET /users?filter=role=in=("admin","moderator")
GET /users?filter=status=out=("deleted","banned")
```

## String Operations

### Pattern Matching (LIKE)

```
field%="pattern"    # LIKE pattern (case-sensitive)
field!%="pattern"   # NOT LIKE pattern
field=ilike="pattern"   # Case-insensitive LIKE
field=nilike="pattern"  # Case-insensitive NOT LIKE
```

SQL LIKE wildcards:
- `%` matches any sequence of characters
- `_` matches any single character

```bash
GET /users?filter=email%="%@gmail.com"
GET /users?filter=name=ilike="%john%"
```

### Contains, Starts With, Ends With

```
field=contains="text"      # Contains substring (case-sensitive)
field=icontains="text"     # Contains substring (case-insensitive)
field=startswith="text"    # Starts with prefix (case-sensitive)
field=istartswith="text"   # Starts with prefix (case-insensitive)
field=endswith="text"      # Ends with suffix (case-sensitive)
field=iendswith="text"     # Ends with suffix (case-insensitive)
```

```bash
GET /users?filter=name=contains="Smith"
GET /users?filter=email=iendswith="@company.com"
GET /users?filter=title=istartswith="senior"
```

### Case-Insensitive Equality

```
field=ieq="value"   # Case-insensitive equals
field=ine="value"   # Case-insensitive not equals
```

```bash
GET /users?filter=status=ieq="active"
GET /products?filter=category=ieq="Electronics"
```

### Regular Expressions

```
field=regex="pattern"    # Matches regex (case-sensitive)
field=iregex="pattern"   # Matches regex (case-insensitive)
```

```bash
GET /users?filter=email=regex="^admin@"
GET /posts?filter=title=iregex="^how to"
```

Note: Regex support varies by database. In-memory filtering uses JavaScript RegExp.

### Length Checks

```
field=length=N       # Exact length
field=minlength=N    # Minimum length
field=maxlength=N    # Maximum length
```

```bash
GET /users?filter=username=minlength=3
GET /posts?filter=title=maxlength=100
```

## Null and Empty Checks

```
field=isnull=true    # Field is null
field=isnull=false   # Field is not null
field=isempty=true   # Field is null or empty string
field=isempty=false  # Field has a non-empty value
```

```bash
GET /users?filter=deletedAt=isnull=true
GET /posts?filter=content=isempty=false
```

## Boolean Comparisons

Boolean values `true` and `false` are parsed and compared intelligently:

```
field==true    # Matches true, 1, "true", "1"
field==false   # Matches false, 0, "false", "0"
field!=true    # Matches anything that's not truthy
field!=false   # Matches anything that's not falsy
```

```bash
GET /users?filter=isActive==true
GET /posts?filter=isDraft==false
GET /users?filter=isVerified!=false
```

This handles the common case where databases store booleans as 0/1 integers.

## Range/Between

```
field=between=[min, max]    # Value is between min and max (inclusive)
field=nbetween=[min, max]   # Value is NOT between min and max
```

Both `[...]` (range) and `(...)` (set) syntax work:

```bash
GET /users?filter=age=between=[18, 65]
GET /products?filter=price=between=(10, 100)
GET /events?filter=date=between=["2024-01-01", "2024-12-31"]
```

## Date Filtering

Dates are automatically parsed from ISO 8601 format strings:

```bash
# Full ISO format
GET /posts?filter=createdAt>"2024-01-15T10:30:00.000Z"

# Date only
GET /posts?filter=createdAt>="2024-01-15"

# Date range
GET /events?filter=startDate=between=["2024-06-01", "2024-06-30"]

# Multiple date conditions
GET /posts?filter=createdAt>="2024-01-01";createdAt<"2024-02-01"
```

## Compound Filters

### AND (semicolon or `&&` or `and`)

```
status=="active";age>18
status=="active" && age>18
status=="active" and age>18
```

### OR (comma or `||` or `or`)

```
role=="admin",role=="moderator"
role=="admin" || role=="moderator"
role=="admin" or role=="moderator"
```

### Grouping (parentheses)

```
(status=="active";age>18),(role=="admin")
```

## Value Types

```
# Strings (quoted)
name=="John Doe"

# Numbers (unquoted)
age==25
price==19.99

# Booleans
active==true
verified==false

# Null
deletedAt==null

# Arrays/Sets
tags=in=("tech","news")

# Ranges
age=between=[18, 65]

# Dates (ISO format, auto-detected)
createdAt>"2024-01-01T00:00:00Z"
createdAt>"2024-01-01"
```

## Examples

```bash
# Get active users over 18
GET /users?filter=status=="active";age>18

# Search users by name (case-insensitive)
GET /users?filter=name=icontains="john"

# Get posts from January 2024
GET /posts?filter=createdAt=between=["2024-01-01", "2024-01-31"]

# Get users with specific email domains
GET /users?filter=email=iendswith="@company.com"

# Complex query: active admins or any moderator
GET /users?filter=(status=="active";role=="admin"),(role=="moderator")

# Products in price range with stock
GET /products?filter=price=between=[10, 100];stock>0

# Users with non-empty bio
GET /users?filter=bio=isempty=false
```

## Escaping

Special characters in strings should be escaped:

```
name=="John \"Johnny\" Doe"
path=="C:\\Users\\John"
```

## Custom Operators

While Covara includes many built-in operators, you can define custom operators for specialized use cases:

```typescript
useResource(usersTable, {
  id: usersTable.id,
  customOperators: {
    "=jsoncontains=": {
      // SQL conversion for database queries
      convert: (lhs, rhs) => sql`JSON_CONTAINS(${lhs}, ${rhs})`,
      // JavaScript execution for subscription filtering
      execute: (lhs, rhs) => {
        const arr = JSON.parse(String(lhs));
        return arr.includes(rhs);
      },
    },
  },
});
```

## Complete Operator Reference

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
| `%=` | LIKE pattern | `name%="%john%"` |
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
| `=isnull=` | Is null check | `deletedAt=isnull=true` |
| `=isempty=` | Is null or empty string | `bio=isempty=true` |
| `=between=` | In range (inclusive) | `age=between=[18,65]` |
| `=nbetween=` | Not in range | `age=nbetween=[0,17]` |
| `=regex=` | Regex match | `email=regex="^admin@"` |
| `=iregex=` | Case-insensitive regex | `name=iregex="^john"` |
| `=length=` | Exact string length | `code=length=6` |
| `=minlength=` | Minimum string length | `password=minlength=8` |
| `=maxlength=` | Maximum string length | `username=maxlength=20` |

**Boolean Handling:**
- `==true` matches `true`, `1`, `"true"`, `"1"`
- `==false` matches `false`, `0`, `"false"`, `"0"`
