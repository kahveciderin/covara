# Error Handling

Covara provides consistent error handling across both server and client with typed errors and detailed error responses.

## Server-Side Errors

### Error Response Format

All errors follow [RFC 7807 Problem Details](https://tools.ietf.org/html/rfc7807) format with `Content-Type: application/problem+json`:

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

### Error Types

| Type | HTTP Status | Description |
|------|-------------|-------------|
| `not-found` | 404 | Resource not found |
| `validation-error` | 400 | Invalid input data |
| `unauthorized` | 401 | Authentication required |
| `forbidden` | 403 | Insufficient permissions |
| `rate-limit-exceeded` | 429 | Too many requests |
| `batch-limit-exceeded` | 400 | Batch size exceeded |
| `filter-parse-error` | 400 | Invalid filter syntax |
| `conflict` | 409 | Resource conflict |
| `precondition-failed` | 412 | ETag mismatch |
| `cursor-invalid` | 400 | Pagination cursor malformed |
| `cursor-expired` | 400 | Pagination cursor expired |
| `idempotency-mismatch` | 409 | Idempotency key reused |
| `internal-error` | 500 | Server error |

### Built-in Error Classes

```typescript
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  BatchLimitError,
  FilterParseError,
  ConflictError,
  PreconditionFailedError,
  ResourceError,
} from "covara";

// Throw in hooks or procedures
throw new NotFoundError("users", "123");
// -> 404: { type: "/__covara/problems/not-found", title: "Not found", status: 404, detail: "users with id '123' not found", ... }

throw new ValidationError("Email is required", { field: "email" });
// -> 400: { type: "/__covara/problems/validation-error", title: "Validation error", status: 400, detail: "Email is required", ... }

throw new ForbiddenError("Cannot delete admin users");
// -> 403: { type: "/__covara/problems/forbidden", title: "Forbidden", status: 403, detail: "Cannot delete admin users" }
```

### Error Handlers

All Covara error classes extend Hono's `HTTPException` and self-render as RFC 7807 `application/problem+json` responses — throwing them from any handler, hook, or procedure produces the correct response.

When using `createCovara`, error handling is wired up automatically. With a plain Hono app, register the handlers yourself:

```typescript
import { Hono } from "hono";
import { errorHandler, notFoundHandler } from "covara";

const app = new Hono();
app.onError(errorHandler);
app.notFound(notFoundHandler);
```

The error handler automatically:
- Formats errors as RFC 7807 Problem Details
- Sets `Content-Type: application/problem+json`
- Adds `Retry-After` header for rate limit errors
- Includes request ID if available
- Logs errors with structured JSON

#### Log severity by status

The error handler picks the log level from the resolved HTTP status: `5xx` server errors are logged
at `error`, while `4xx` client errors (validation, not-found, precondition, rate-limit, auth) are
logged at `warn`. This keeps expected client errors from drowning out genuine server faults in your
logs. Each record includes `requestId`, `method`, `path`, `status`, and the error message (plus the
stack trace when debug mode is enabled).

### Validation Errors

Validation errors from Zod include field-level details in the `errors` array:

```json
{
  "type": "/__covara/problems/validation-error",
  "title": "Validation error",
  "status": 400,
  "detail": "Request validation failed",
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "email", "message": "Invalid email format" },
    { "field": "age", "message": "Expected number, received string" }
  ]
}
```

## Client-Side Error Handling

### TransportError

The client throws `TransportError` for all HTTP errors:

```typescript
import { TransportError } from "covara/client";

try {
  await users.get("nonexistent");
} catch (error) {
  if (error instanceof TransportError) {
    console.log(error.status);   // 404
    console.log(error.code);     // "NOT_FOUND"
    console.log(error.type);     // "/__covara/problems/not-found"
    console.log(error.title);    // "Not found"
    console.log(error.detail);   // "users with id 'nonexistent' not found"
  }
}
```

### Status Check Methods

```typescript
try {
  await users.get("123");
} catch (error) {
  if (error instanceof TransportError) {
    if (error.isNotFound()) {
      // Handle 404
      showNotFoundPage();
    } else if (error.isUnauthorized()) {
      // Handle 401
      redirectToLogin();
    } else if (error.isForbidden()) {
      // Handle 403
      showPermissionDenied();
    } else if (error.isValidationError()) {
      // Handle 400
      showValidationErrors(error.details);
    } else if (error.isRateLimited()) {
      // Handle 429
      showRateLimitMessage();
    } else if (error.isServerError()) {
      // Handle 5xx
      showServerError();
    }
  }
}
```

### Handling Specific Operations

```typescript
// Create with validation handling
async function createUser(data: UserInput) {
  try {
    return await users.create(data);
  } catch (error) {
    if (error instanceof TransportError && error.isValidationError()) {
      // Extract field errors
      const fieldErrors = error.details as Array<{ field: string; message: string }>;
      return { success: false, errors: fieldErrors };
    }
    throw error;
  }
}

// Delete with not-found handling
async function deleteUser(id: string) {
  try {
    await users.delete(id);
    return true;
  } catch (error) {
    if (error instanceof TransportError && error.isNotFound()) {
      // Already deleted or never existed
      return true;
    }
    throw error;
  }
}
```

### Global Error Handler

```typescript
import { getOrCreateClient } from "covara/client";

const client = getOrCreateClient({
  baseUrl: "/api",
  credentials: "include",
  offline: true,
  onError: (error) => {
    // Called for offline mutation sync failures
    if (error instanceof TransportError) {
      if (error.isServerError()) {
        // Log to error tracking service
        errorTracker.capture(error);
      }
    }
  },
});

// Set global auth error handler (called on 401 responses)
client.setAuthErrorHandler(() => {
  redirectToLogin();
});
```

### React Integration

With the `useAuth` hook, auth errors are handled automatically:

```typescript
import { useAuth, useLiveList } from "covara/client/react";

function App() {
  const { user, isAuthenticated, logout } = useAuth<User>();

  // Set auth error handler to trigger logout
  useEffect(() => {
    client.setAuthErrorHandler(logout);
  }, [logout]);

  // useLiveList automatically handles auth errors via the global handler
  const { items, error } = useLiveList<Todo>("/api/todos");

  if (!isAuthenticated) return <LoginPage />;
  return <TodoList items={items} />;
}
```

## Error Handling Patterns

### Retry with Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof TransportError) {
        // Don't retry client errors
        if (error.status < 500) throw error;
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, delay * Math.pow(2, attempt)));
    }
  }

  throw lastError!;
}

// Usage
const user = await withRetry(() => users.get("123"));
```

### Form Validation

```typescript
interface FormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  isSubmitting: boolean;
}

async function handleSubmit(state: FormState): Promise<FormState> {
  state.isSubmitting = true;
  state.errors = {};

  try {
    await users.create(state.values);
    return { ...state, isSubmitting: false };
  } catch (error) {
    if (error instanceof TransportError && error.isValidationError()) {
      const fieldErrors = error.details as Array<{ field: string; message: string }>;
      const errors: Record<string, string> = {};

      for (const { field, message } of fieldErrors) {
        errors[field] = message;
      }

      return { ...state, isSubmitting: false, errors };
    }
    throw error;
  }
}
```

### Error Boundary (React)

```typescript
function useResource<T>(resource: ResourceClient<T>) {
  const [data, setData] = useState<T[]>([]);
  const [error, setError] = useState<TransportError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    resource.list()
      .then(result => {
        setData(result.items);
        setError(null);
      })
      .catch(err => {
        if (err instanceof TransportError) {
          setError(err);
        } else {
          throw err; // Let error boundary handle
        }
      })
      .finally(() => setLoading(false));
  }, [resource]);

  return { data, error, loading };
}
```

## Throwing Errors in Hooks

```typescript
app.route("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
  hooks: {
    onBeforeCreate: async (ctx, data) => {
      // Validate business rules
      if (data.role === "admin" && !ctx.user?.isAdmin) {
        throw new ForbiddenError("Only admins can create admin users");
      }

      // Check for duplicates
      const existing = await ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, data.email));

      if (existing.length > 0) {
        throw new ConflictError("Email already in use", { email: data.email });
      }

      return data;
    },

    onBeforeDelete: async (ctx, id) => {
      // Prevent self-deletion
      if (id === ctx.user?.id) {
        throw new ForbiddenError("Cannot delete your own account");
      }
    },
  },
}));
```

## Throwing Errors in Procedures

```typescript
procedures: {
  transferOwnership: {
    input: z.object({
      toUserId: z.string(),
    }),
    handler: async (ctx, input) => {
      const newOwner = await ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, input.toUserId));

      if (newOwner.length === 0) {
        throw new NotFoundError("users", input.toUserId);
      }

      if (newOwner[0].status !== "active") {
        throw new ValidationError("Cannot transfer to inactive user");
      }

      // Proceed with transfer
    },
  },
}
```

## Best Practices

1. **Use specific error types** - Don't throw generic errors
2. **Include details** - Provide context for debugging
3. **Handle all error types** - Don't let errors go unhandled
4. **Log server errors** - Track 5xx errors for investigation
5. **Show user-friendly messages** - Don't expose internal details
6. **Retry transient errors** - Network issues often resolve
7. **Validate early** - Catch errors before they reach the database
