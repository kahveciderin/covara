# Admin UI

Covara includes a comprehensive admin dashboard for development and debugging at `/__covara/ui`. It provides a one-stop shop for monitoring, testing, and debugging your API with environment-aware features.

## Setup

With `createCovara`, just enable it:

```typescript
const app = createCovara({
  adminUI: true,                       // or a full AdminUIConfig object
});
```

Health endpoints are mounted by default and the admin UI is served at `/__covara`.

For manual setup with a plain Hono app:

```typescript
import { Hono } from "hono";
import { createAdminUI, registerResource } from "covara/ui";
import { createHealthEndpoints } from "covara";
import { createMetricsCollector, observabilityMiddleware } from "covara/middleware/observability";

const app = new Hono();

// Create metrics collector
const metricsCollector = createMetricsCollector({ maxMetrics: 1000 });

// Add observability middleware to track requests
app.use("*", observabilityMiddleware({ metrics: metricsCollector }));

// Mount health endpoints (no auth required for k8s probes)
app.route("/", createHealthEndpoints({
  version: "1.0.0",
  checks: { kv: myKVStore },
  thresholds: { eventLoopLagMs: 100, memoryPercent: 90 },
}));

// Mount admin UI at /__covara
app.route("/__covara", createAdminUI({
  title: "My API Admin",
  metricsCollector,
  // Security configuration for production
  security: {
    mode: process.env.NODE_ENV as "development" | "staging" | "production",
    auth: { apiKey: process.env.ADMIN_API_KEY },
  },
  // Data explorer configuration
  dataExplorer: {
    enabled: true,
    readOnly: process.env.NODE_ENV === "production",
    excludeFields: { users: ["password", "apiKey"] },
  },
  // Task queue monitoring
  taskMonitor: {
    enabled: true,
    scheduler: getTaskScheduler(),
    workers: myWorkers,
  },
  // KV store inspection
  kvInspector: {
    enabled: process.env.NODE_ENV !== "production",
    kv: myKVStore,
    readOnly: process.env.NODE_ENV === "staging",
  },
  // Changelog for replay debugging
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
  // Subscription monitoring
  getActiveSubscriptions: () => subscriptionManager.getActive(),
}));

// Register resources for visibility in the admin panel
app.route("/posts", useResource(postsTable, { ... }));
registerResource({
  path: "/posts",
  fields: ["id", "title", "content", "authorId", "createdAt"],
  capabilities: { enableSubscriptions: true },
  auth: { public: { read: true } },
});
```

## Health Endpoints

Kubernetes-compatible health probes for liveness and readiness checks:

```typescript
import { createHealthEndpoints } from "covara";

app.route("/", createHealthEndpoints({
  enabled: true,           // Default: true
  basePath: "",            // Default: "" (root level)
  version: "1.0.0",        // Optional version in response
  checks: {
    kv: myKVStore,         // KV store connection check
    custom: async () => ({ // Custom health check
      healthy: true,
      name: "database",
      message: "Connected",
    }),
  },
  thresholds: {
    eventLoopLagMs: 100,   // Default: 100ms
    memoryPercent: 90,     // Default: 90%
  },
}));
```

### `/healthz` (Liveness)

Returns 200 if the process is responsive. Used by Kubernetes for container restarts.

```bash
curl localhost:3000/healthz
```

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "uptime": 3600,
  "version": "1.0.0",
  "checks": [
    { "name": "event_loop", "healthy": true, "latencyMs": 2 },
    { "name": "memory", "healthy": true, "usagePercent": 45 }
  ]
}
```

**Checks performed:**
- Event loop lag (< threshold)
- Memory usage (< threshold)

### `/readyz` (Readiness)

Returns 200 only if all dependencies are healthy. Used by Kubernetes for traffic routing.

```bash
curl localhost:3000/readyz
```

**Checks performed:**
- KV connection (if configured)
- Custom checks (if configured)

Returns 503 with failed check details if unhealthy.

## Environment-Aware Behavior

The admin UI adapts based on the environment mode:

| Feature | Development | Staging | Production |
|---------|-------------|---------|------------|
| Auth required | No (warning shown) | Yes | Yes |
| Data editor | Enabled | Enabled (audit logged) | Disabled by default |
| IP allowlist | Ignored | Optional | Enforced if set |
| Debug info | Full | Partial | Minimal |
| KV inspector | Enabled | Read-only | Disabled |

### Environment Badge

A visual indicator in the header shows the current environment:
- **DEV** - Green badge
- **STAGING** - Yellow/Orange badge
- **PROD** - Blue badge (default theme)

Warning banners appear for insecure configurations (e.g., auth disabled in production).

## Admin Authentication

Configure authentication for the admin panel:

```typescript
createAdminUI({
  security: {
    // Auto-detect from NODE_ENV or set explicitly
    mode: "production",

    auth: {
      // Option 1: API key authentication
      apiKey: "your-secret-key",

      // Option 2: Disable auth (development only)
      disabled: true,

      // Option 3: Custom authentication (c is the Hono Context)
      authenticate: async (c) => {
        const session = await validateSession(getCookie(c, "session"));
        if (!session) return null;
        return {
          id: session.userId,
          email: session.email,
          roles: session.roles,
        };
      },
    },

    authorization: {
      // Require specific role
      requiredRole: "admin",
      // Or require specific permission
      requiredPermission: "admin:access",
      // Or custom authorization
      authorize: async (user) => user.roles.includes("super-admin"),
    },

    // App-auth integration (preferred): authenticate the admin UI using the
    // application's own logged-in user (resolved via getUser(c)).
    // Configuring any of requireRole / authorize / can (or auth.useSessionAuth)
    // switches the UI to session-based auth: anonymous requests get 401,
    // unauthorized users get 403.
    requireRole: "admin",                 // string or string[] (any match passes)
    authorize: (user, c) => user.email.endsWith("@yourco.com"),
    can: (user, action, resource) => user.roles.includes("admin"),

    // Persistent / exportable audit: forward every admin action to your own
    // sink (DB, log pipeline, etc) in addition to the in-memory ring buffer.
    auditSink: async (entry) => {
      await db.insert(adminAuditTable).values(entry);
    },

    // IP allowlist (enforced in production)
    allowedIPs: ["10.0.0.0/8", "192.168.1.100"],

    // Rate limiting
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100,
    },
  },
});
```

### Authentication Methods

**API Key:**
```bash
# Via header
curl -H "X-Admin-API-Key: your-key" localhost:3000/__covara/api/data/users

# Via Bearer token
curl -H "Authorization: Bearer your-key" localhost:3000/__covara/api/data/users
```

**Session Auth (app integration):**
Uses the existing logged-in user from your application's auth system. When
`requireRole`, `authorize`, or `can` is configured (or `auth.useSessionAuth: true`),
the admin UI reads the user via `getUser(c)` and enforces the configured checks.

Resolution order:
1. `auth.disabled` — bypass (warns outside development).
2. `auth.apiKey` — Bearer token or `X-Admin-API-Key` header.
3. Session user (`getUser(c)`) when `requireRole` / `authorize` / `can` / `auth.useSessionAuth` is set.
4. `auth.authenticate(c)` — custom resolver.
5. Otherwise: 401. In development with no auth configured, access is allowed; in
   staging/production with no auth configured, access is denied (fail-closed).

**Role lookup contract:** `requireRole` checks the user's roles, gathered (and
merged) from `user.roles` (string[]), `user.role` (string), `user.metadata.roles`
(string[]), and `user.metadata.role` (string). `requireRole` accepts a single role
or an array; the check passes if the user has any of the required roles.

**Audit export:** `GET /__covara/admin/audit/export` returns the audit log as
JSON (`{ entries, mode, exportedAt }`), gated by the same authorization. The
legacy `GET /__covara/api/admin-audit/export?format=json|csv` is also available.

## Pages

The admin UI includes multiple pages organized into sections:

### Overview Section

#### Dashboard

The main dashboard provides a high-level overview of your API:

| Stat | Description |
|------|-------------|
| Resources | Number of registered resources |
| Requests | Total tracked requests |
| Avg Response | Average response time in milliseconds |
| Errors | Number of logged errors |
| Slow Queries | Requests exceeding the slow threshold |

Also displays:
- Recent requests with method, path, and response time
- Quick resource list with field counts and capabilities

#### Resources

Detailed view of all registered resources. Click any resource to expand and see:

- **Fields** - All available fields on the resource
- **Capabilities** - Enabled features (Create, Update, Delete, Subscriptions, Aggregations)
- **Auth Configuration** - Public access settings and scope requirements
- **RPC Procedures** - Available custom procedures
- **Endpoints** - Full endpoint reference table with methods and paths

#### Requests

Real-time request monitoring with filtering:

- **Method Filter** - Filter by GET, POST, PATCH, PUT, DELETE
- **Status Filter** - Show only success (2xx/3xx) or error (4xx/5xx) responses
- **Path Filter** - Search by path substring

Each request shows:
- HTTP method with color-coded badge
- Request path
- Status code (green for success, red for error)
- Duration with color coding (green < 100ms, yellow < 500ms, red > 500ms)
- Timestamp

Click any request to view full details including headers and body.

#### Errors

Error log showing recent API errors:

- Status code badge
- Request path
- Timestamp
- Error message
- Expandable stack trace (click to reveal)

### Data Section

#### Data Explorer

Browse and search resource data with admin bypass:

```typescript
createAdminUI({
  dataExplorer: {
    enabled: true,
    resources: ["users", "posts"],       // Whitelist (empty = all)
    excludeFields: {                     // Redact sensitive fields
      users: ["password", "apiKey"],
    },
    maxLimit: 100,                       // Max records per page
    readOnly: true,                      // Disable mutations
  },
});
```

**Features:**
- Resource selector dropdown
- Filter input (RSQL syntax)
- Column selection
- Pagination controls
- Expandable row details
- Visual "Admin bypass active" warning banner

**API Endpoints:**
```
GET  /__covara/api/data/:resource          # List with pagination
GET  /__covara/api/data/:resource/:id      # Get single record
GET  /__covara/api/data/:resource/schema   # Schema introspection
```

All access is logged to the admin audit log.

#### Data Editor

Modify resource data with full audit logging (when `readOnly: false`):

**Features:**
- "New Record" button with auto-generated form
- Edit button per row (modal with field editors)
- Delete button with confirmation dialog
- Before/after values logged for all mutations

**API Endpoints:**
```
POST   /__covara/api/data/:resource        # Create
PATCH  /__covara/api/data/:resource/:id    # Update
DELETE /__covara/api/data/:resource/:id    # Delete
```

#### Admin Audit Log

View all admin bypass operations:

**Features:**
- Timestamp, user, and operation details
- Before/after values for mutations
- Filterable by user, operation type, date range
- Export to JSON/CSV

**API Endpoint:**
```
GET /__covara/api/admin-audit?limit=100&offset=0
```

### Tools Section

#### Filter Tester

Interactive filter expression testing and validation:

1. **Expression Input** - Enter any filter expression
2. **Parse Button** - Validates and parses the expression
3. **AST View** - Shows the parsed abstract syntax tree
4. **SQL Equivalent** - Displays the generated SQL WHERE clause
5. **Test Query** - Select a resource and execute the filter live

**Operator Reference Table:**

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equals | `status=="active"` |
| `!=` | Not equals | `status!="deleted"` |
| `>` | Greater than | `age>18` |
| `>=` | Greater or equal | `age>=18` |
| `<` | Less than | `price<100` |
| `<=` | Less or equal | `price<=100` |
| `=in=` | In list | `role=in=("admin","user")` |
| `=out=` | Not in list | `status=out=("deleted")` |
| `%=` | LIKE pattern | `name%="John%"` |
| `=isnull=` | Is null check | `deletedAt=isnull=true` |
| `;` | AND combinator | `a==1;b==2` |
| `,` | OR combinator | `a==1,a==2` |
| `()` | Grouping | `(a==1;b==2),c==3` |

#### API Explorer

Interactive API testing without leaving the browser:

1. **Method Selector** - Choose HTTP method
2. **Resource Selector** - Quick-select registered resources
3. **Path Input** - Full URL path with query parameters
4. **Request Body** - JSON editor for POST/PATCH/PUT requests
5. **Response Viewer** - Formatted JSON response with status and timing

Example workflow:
```
Method: GET
Path: /users?filter=role=="admin"&limit=10
[Send]

Response: 200 (45ms)
{
  "data": [...],
  "pagination": { ... }
}
```

#### Subscriptions

SSE subscription monitor for debugging real-time features:

1. **Resource Selector** - Choose from resources with subscriptions enabled
2. **Filter Input** - Optional filter expression for the subscription
3. **Connect/Disconnect** - Manage the SSE connection
4. **Event Stream** - Live view of incoming events

Event types displayed:
- `existing` (blue) - Initial data on connection
- `added` (green) - New items matching filter
- `changed` (yellow) - Updated items
- `removed` (red) - Deleted items or items leaving filter scope

Each event shows:
- Event type badge
- ISO timestamp
- Full JSON payload

#### Changelog

Database mutation log viewer for subscription replay debugging:

**Stats:**
- Current Sequence - Latest changelog sequence number
- Entries Shown - Number of entries in view

**Entry Table:**
| Column | Description |
|--------|-------------|
| Seq | Sequence number |
| Type | create, update, or delete |
| Resource | Resource path |
| ID | Entity identifier |
| Time | Mutation timestamp |

Requires changelog configuration in `createAdminUI()`.

### Background Tasks Section

#### Task Queue Monitor

Monitor and manage background tasks:

```typescript
createAdminUI({
  taskMonitor: {
    enabled: true,
    scheduler: getTaskScheduler(),
    workers: myWorkers,
  },
});
```

**Features:**
- Queue depth by priority (0, 25, 50, 75, 100)
- List of scheduled/running tasks
- Task details with input/output
- Worker status cards

**API Endpoints:**
```
GET  /__covara/api/tasks/queue         # Queue stats
GET  /__covara/api/tasks/task/:id      # Task details
GET  /__covara/api/tasks/workers       # Worker status
```

#### Dead Letter Queue

Failed task management:

**Features:**
- Browse failed tasks
- View error details and stack traces
- Retry individual tasks
- Purge tasks from DLQ

**API Endpoints:**
```
GET    /__covara/api/tasks/dlq           # List DLQ entries
POST   /__covara/api/tasks/dlq/:id/retry # Retry a task
DELETE /__covara/api/tasks/dlq/:id       # Remove from DLQ
```

### KV Store Section

#### KV Inspector

Browse and edit the key-value store (development/staging only):

```typescript
createAdminUI({
  kvInspector: {
    enabled: true,
    kv: myKVStore,
    readOnly: false,                     // Enable writes
    allowedPatterns: ["cache:*"],        // Restrict browsable keys
  },
});
```

**Features:**
- Key browser with glob pattern search
- Value viewer (JSON formatted for objects)
- Inline value editor
- TTL display and modification
- Key deletion with confirmation
- Support for string, hash, list, set, and zset types

**API Endpoints:**
```
GET    /__covara/api/kv/keys?pattern=*   # List keys
GET    /__covara/api/kv/key/:key         # Get value
PUT    /__covara/api/kv/key/:key         # Set value
DELETE /__covara/api/kv/key/:key         # Delete key
GET    /__covara/api/kv/key/:key/ttl     # Get TTL
```

### Help Section

#### Error Docs

Local reference for all API error types. Click any error type to see:

- **Title** - Human-readable error name
- **Description** - What the error means
- **Solutions** - Actionable steps to resolve

Available error types:

| Type | Description |
|------|-------------|
| `not-found` | Resource doesn't exist |
| `validation-error` | Request body validation failed |
| `unauthorized` | Authentication required |
| `forbidden` | Insufficient permissions |
| `rate-limit-exceeded` | Too many requests |
| `batch-limit-exceeded` | Batch size exceeded |
| `filter-parse-error` | Invalid filter syntax |
| `conflict` | Resource state conflict |
| `precondition-failed` | ETag mismatch (optimistic concurrency) |
| `cursor-invalid` | Pagination cursor malformed or incompatible |
| `cursor-expired` | Pagination cursor expired |
| `idempotency-mismatch` | Idempotency key reused with different params |
| `unsupported-version` | Client version below minimum |
| `internal-error` | Server error |
| `unknown-error` | Unrecognized error |

These docs are served locally at `/__covara/problems/:type` and are referenced by the `type` field in RFC 7807 problem details responses. All API error responses now use relative URLs instead of external URLs.

## Configuration

```typescript
interface AdminUIConfig {
  // Custom page title (default: "Covara Admin")
  title?: string;

  // Base path for API URLs (default: "/__covara")
  basePath?: string;

  // Security configuration
  security?: {
    mode?: "development" | "staging" | "production";
    auth?: {
      disabled?: boolean;
      useSessionAuth?: boolean;
      apiKey?: string;
      authenticate?: (c: Context) => Promise<AdminUser | null>;
    };
    authorization?: {
      requiredRole?: string;
      requiredPermission?: string;
      authorize?: (user: AdminUser) => Promise<boolean>;
    };

    // App-auth integration (resolves the logged-in user via getUser(c)).
    // Setting any of these enables session-based auth for the admin UI.
    requireRole?: string | string[];
    authorize?: (user: AdminUser, c: Context) => boolean | Promise<boolean>;
    can?: (user: AdminUser, action: string, resource: string) => boolean | Promise<boolean>;

    // Pluggable persistent audit sink (called in addition to the in-memory buffer).
    auditSink?: (entry: AdminAuditEntry) => void | Promise<void>;

    allowedIPs?: string[];
    rateLimit?: { windowMs: number; maxRequests: number };
  };

  // Data explorer configuration
  dataExplorer?: {
    enabled?: boolean;
    resources?: string[];
    excludeFields?: Record<string, string[]>;
    maxLimit?: number;
    readOnly?: boolean;
  };

  // Task queue monitoring
  taskMonitor?: {
    enabled?: boolean;
    scheduler?: TaskScheduler;
    workers?: TaskWorker[];
  };

  // KV store inspection
  kvInspector?: {
    enabled?: boolean;
    kv?: KVAdapter;
    readOnly?: boolean;
    allowedPatterns?: string[];
  };

  // Metrics collector for request tracking
  metricsCollector?: {
    getRecent: (count: number) => RequestMetric[];
    getSlow: (thresholdMs: number) => RequestMetric[];
  };

  // Changelog access for replay debugging
  changelog?: {
    getCurrentSequence: () => Promise<number>;
    getEntries: (fromSeq: number, limit: number) => Promise<ChangelogEntry[]>;
  };

  // Active subscription monitoring
  getActiveSubscriptions?: () => Subscription[];
}
```

### Full Example

```typescript
import { createAdminUI, registerResource } from "covara/ui";
import { changelog, createHealthEndpoints } from "covara";
import { createMetricsCollector, observabilityMiddleware } from "covara/middleware/observability";
import { getTaskScheduler, getTaskRegistry, startTaskWorkers } from "covara/tasks";
import { createKV } from "covara/kv";

const metricsCollector = createMetricsCollector({ maxMetrics: 1000 });

const kv = await createKV({ type: "redis", redis: { url: "redis://localhost" } });
const workers = await startTaskWorkers(kv, getTaskRegistry(), 3);

app.use("*", observabilityMiddleware({ metrics: metricsCollector }));

// Health endpoints (no auth)
app.route("/", createHealthEndpoints({
  version: "1.0.0",
  checks: { kv },
}));

// Admin UI (with auth in production)
app.route("/__covara", createAdminUI({
  title: "My API Admin",
  metricsCollector,
  security: {
    mode: process.env.NODE_ENV as "development" | "staging" | "production",
    auth: { apiKey: process.env.ADMIN_API_KEY },
    authorization: { requiredRole: "admin" },
  },
  dataExplorer: {
    enabled: true,
    readOnly: process.env.NODE_ENV === "production",
    excludeFields: { users: ["password"] },
  },
  taskMonitor: {
    enabled: true,
    scheduler: getTaskScheduler(),
    workers,
  },
  kvInspector: {
    enabled: process.env.NODE_ENV !== "production",
    kv,
    readOnly: process.env.NODE_ENV === "staging",
  },
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
}));
```

## Schema Auto-Discovery

When using `useResource()`, schemas are automatically registered in a global schema registry. The data explorer uses this registry to introspect available resources without manual registration.

```typescript
// Schemas are automatically discovered
app.route("/users", useResource(usersTable, { ... }));
app.route("/posts", useResource(postsTable, { ... }));

// Data explorer will show both users and posts
// with full schema information including:
// - Column names and types
// - Primary keys
// - Nullable fields
// - Relations
// - Available procedures
```

## Registering Resources

Resources must be registered to appear in the admin panel:

```typescript
import { registerResource, unregisterResource, clearRegistry } from "covara/ui";

// Register a resource
registerResource({
  path: "/users",
  fields: ["id", "name", "email", "role", "createdAt", "updatedAt"],
  capabilities: {
    enableCreate: true,
    enableUpdate: true,
    enableDelete: true,
    enableSubscriptions: true,
    enableAggregations: true,
  },
  auth: {
    public: { read: true, subscribe: true },
    hasReadScope: true,
    hasUpdateScope: true,
    hasDeleteScope: true,
  },
  procedures: ["changeEmail", "resetPassword", "deactivate"],
});

// Unregister a specific resource
unregisterResource("/users");

// Clear all registered resources
clearRegistry();
```

### ResourceRegistry Interface

```typescript
interface ResourceRegistry {
  // API path (e.g., "/users")
  path: string;

  // Available fields
  fields: string[];

  // Feature flags
  capabilities?: {
    enableCreate?: boolean;
    enableUpdate?: boolean;
    enableDelete?: boolean;
    enableSubscriptions?: boolean;
    enableAggregations?: boolean;
  };

  // Auth configuration summary
  auth?: {
    public?: { read?: boolean; subscribe?: boolean };
    hasReadScope?: boolean;
    hasUpdateScope?: boolean;
    hasDeleteScope?: boolean;
  };

  // Available RPC procedures
  procedures?: string[];
}
```

## API Endpoints

The admin UI exposes these JSON API endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /__covara/api/resources` | List registered resources |
| `GET /__covara/api/metrics` | Request metrics and slow queries |
| `GET /__covara/api/requests` | Request log (up to 200) |
| `GET /__covara/api/errors` | Error log (up to 100) |
| `GET /__covara/api/changelog` | Changelog entries |
| `GET /__covara/api/subscriptions` | Active SSE subscriptions |
| `GET /__covara/api/environment` | Current environment info |
| `GET /__covara/api/admin-audit` | Admin audit log |
| `GET /__covara/api/data/:resource` | Data explorer (list) |
| `GET /__covara/api/data/:resource/:id` | Data explorer (get) |
| `GET /__covara/api/data/:resource/schema` | Schema introspection |
| `POST /__covara/api/data/:resource` | Data editor (create) |
| `PATCH /__covara/api/data/:resource/:id` | Data editor (update) |
| `DELETE /__covara/api/data/:resource/:id` | Data editor (delete) |
| `GET /__covara/api/tasks/queue` | Task queue stats |
| `GET /__covara/api/tasks/task/:id` | Task details |
| `GET /__covara/api/tasks/dlq` | Dead letter queue |
| `POST /__covara/api/tasks/dlq/:id/retry` | Retry failed task |
| `DELETE /__covara/api/tasks/dlq/:id` | Remove from DLQ |
| `GET /__covara/api/tasks/workers` | Worker status |
| `GET /__covara/api/kv/keys` | KV key listing |
| `GET /__covara/api/kv/key/:key` | KV get value |
| `PUT /__covara/api/kv/key/:key` | KV set value |
| `DELETE /__covara/api/kv/key/:key` | KV delete key |
| `GET /__covara/problems/:type` | Error type documentation |

## Theming

### Dark Mode

Toggle between light and dark themes using the button in the header. Theme preference is persisted in localStorage under the key `covara-theme`.

### Design System

The UI uses CSS custom properties for consistent styling:

```css
:root {
  --bg-0: #ffffff;      /* Page background */
  --bg-1: #fafafa;      /* Card background */
  --bg-2: #f0f0f0;      /* Header background */
  --accent: #0066ff;    /* Primary accent color */
  --success: #00875a;   /* Success states */
  --warning: #b86e00;   /* Warning states */
  --error: #de350b;     /* Error states */
  --radius: 4px;        /* Border radius */
}
```

## Security

The admin UI is designed for all environments with appropriate security controls:

### Development Mode

Auth is optional with a warning banner. Full debug information available.

### Production Mode

Auth is required. Use one of these approaches:

**API Key Authentication:**
```typescript
createAdminUI({
  security: {
    mode: "production",
    auth: { apiKey: process.env.ADMIN_API_KEY },
  },
});
```

**Role-Based Access:**
```typescript
createAdminUI({
  security: {
    mode: "production",
    auth: {
      authenticate: async (req) => validateSession(req),
    },
    authorization: { requiredRole: "admin" },
  },
});
```

**IP Allowlisting:**
```typescript
createAdminUI({
  security: {
    mode: "production",
    auth: { apiKey: process.env.ADMIN_API_KEY },
    allowedIPs: ["10.0.0.0/8", "192.168.1.100"],
  },
});
```

### Disable Completely in Production

```typescript
if (process.env.NODE_ENV !== "production") {
  app.route("/__covara", createAdminUI({ ... }));
}
```

## Troubleshooting

### Resources Not Appearing

Ensure you call `registerResource()` after setting up the resource route:

```typescript
// Correct order
app.route("/users", useResource(usersTable, { ... }));
registerResource({ path: "/users", ... });
```

### Metrics Not Updating

Verify the observability middleware is added before your routes:

```typescript
// Correct order
app.use("*", observabilityMiddleware({ metrics: metricsCollector }));
app.route("/users", useResource(usersTable, { ... }));
```

### Changelog Shows "Not Configured"

Pass the changelog configuration to `createAdminUI()`:

```typescript
createAdminUI({
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
})
```

### Health Endpoints Returning 503

Check individual health check results in the response:

```bash
curl -s localhost:3000/healthz | jq '.checks'
```

Common issues:
- KV store not connected
- Memory threshold exceeded
- Event loop lag due to heavy processing

### Admin Auth Returning 401

Verify your authentication method:

```bash
# API key via header
curl -H "X-Admin-API-Key: your-key" localhost:3000/__covara/api/resources

# API key via Bearer token
curl -H "Authorization: Bearer your-key" localhost:3000/__covara/api/resources
```

## Related

- [Resources](./resources.md) - Resource configuration
- [Tasks](./tasks.md) - Background task configuration
- [Middleware](./middleware.md) - Observability setup
- [Filtering](./filtering.md) - Filter syntax details
- [Subscriptions](./subscriptions.md) - Real-time subscriptions
- [Error Handling](./error-handling.md) - Error types and responses
