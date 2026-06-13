---
id: error-handling
title: Error handling
sidebar_label: Error handling
description: RFC 7807 Problem Details responses, the built-in error classes, status-aware logging, and the client TransportError with status-check helpers.
---

# Error handling

Covara uses consistent, typed errors end to end. The server emits [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807); the client surfaces them as a `TransportError` with status helpers.

## Problem Details format

All errors use `Content-Type: application/problem+json`:

```json
{
  "type": "/__covara/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "users with id '123' not found",
  "code": "NOT_FOUND",
  "resource": "users",
  "id": "123"
}
```

## Error types

| Type | Status | Description |
|------|--------|-------------|
| `not-found` | 404 | Resource not found |
| `validation-error` | 400 | Invalid input |
| `unauthorized` | 401 | Authentication required |
| `forbidden` | 403 | Insufficient permissions |
| `rate-limit-exceeded` | 429 | Too many requests |
| `batch-limit-exceeded` | 400 | Batch size exceeded |
| `filter-parse-error` | 400 | Invalid filter syntax |
| `conflict` | 409 | Resource conflict |
| `precondition-failed` | 412 | [ETag](../core/optimistic-locking.md) mismatch |
| `cursor-invalid` / `cursor-expired` | 400 | Bad [pagination cursor](../core/pagination.md) |
| `idempotency-mismatch` | 409 | Idempotency key reused |
| `internal-error` | 500 | Server error |

## Error classes

```typescript
import {
  NotFoundError, ValidationError, UnauthorizedError, ForbiddenError,
  RateLimitError, BatchLimitError, FilterParseError, ConflictError,
  PreconditionFailedError, ResourceError,
} from "covara";

throw new NotFoundError("users", "123");
throw new ValidationError("Email is required", { field: "email" });
throw new ForbiddenError("Cannot delete admin users");
throw new ConflictError("Email already in use", { email });
```

All classes extend Hono's `HTTPException` and self-render as `application/problem+json`, so throwing them from any handler, [hook](../core/procedures.md), or [procedure](../core/procedures.md) produces the correct response.

```typescript
hooks: {
  onBeforeCreate: async (ctx, data) => {
    if (data.role === "admin" && !ctx.user?.isAdmin)
      throw new ForbiddenError("Only admins can create admin users");
    return data;
  },
  onBeforeDelete: async (ctx, id) => {
    if (id === ctx.user?.id) throw new ForbiddenError("Cannot delete your own account");
  },
}
```

## Error handlers

`createCovara` wires error handling automatically. With a plain Hono app, register the handlers yourself:

```typescript
import { Hono } from "hono";
import { errorHandler, notFoundHandler } from "covara";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);
```

The handler formats RFC 7807, sets the content type, adds `Retry-After` for rate limits, includes the request ID, and logs with structured JSON. **Log severity follows status:** `5xx` are logged at `error`, `4xx` (validation, not-found, precondition, rate-limit, auth) at `warn`, so expected client errors don't drown out genuine faults. Each record includes `requestId`, `method`, `path`, `status`, and the message (plus the stack in debug mode).

Zod validation errors include field details:

```json
{
  "type": "/__covara/problems/validation-error",
  "status": 400,
  "errors": [{ "field": "email", "message": "Invalid email format" }]
}
```

## Client: `TransportError`

```typescript
import { TransportError } from "covara/client";

try {
  await users.get("nope");
} catch (error) {
  if (error instanceof TransportError) {
    error.status; error.code; error.type; error.title; error.detail;
    if (error.isNotFound()) {}
    else if (error.isUnauthorized()) {}
    else if (error.isForbidden()) {}
    else if (error.isValidationError()) showFieldErrors(error.details);
    else if (error.isRateLimited()) console.log("retry after", error.retryAfter);
    else if (error.isServerError()) {}
  }
}
```

Set a global handler for `401`s and offline-sync failures:

```typescript
client.setAuthErrorHandler(() => redirectToLogin());
const client = getOrCreateClient({ baseUrl: "/api", onError: (e) => errorTracker.capture(e) });
```

In React, wire `useAuth`'s `logout` into `setAuthErrorHandler`; `useLiveList` then handles auth errors via the global handler. See [Client auth](../client/auth.md).

## Related

- [Middleware](./middleware.md) · [Optimistic locking](../core/optimistic-locking.md) · [Client overview](../client/overview.md)
