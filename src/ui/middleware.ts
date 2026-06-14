import { Hono, type Context, type MiddlewareHandler } from "hono";
import { eq, and, count, getTableColumns } from "drizzle-orm";
import { getResourceSchema, getResourceScopeResolver, getSchemaInfo, getAllResourcesForDisplay } from "./schema-registry";
import { createResourceFilter } from "@/resource/filter";
import { createPagination, decodeCursorLegacy, parseOrderBy } from "@/resource/pagination";
import { readJsonBody } from "@/server/request";
import { readEnv } from "@/server/env";
import {
  createKVLogAdapter,
  type ObservabilityLogAdapter,
} from "@/observability/log-adapter";
import {
  createAdminAuthMiddleware,
  AdminSecurityConfig,
  getAdminAuditLog,
  getAdminAuditLogAsync,
  setAdminAuditAdapter,
  detectEnvironment,
  setAdminAuditSink,
  getAdminUser,
  logAdminAction,
  type AdminAuditEntry,
} from "./admin-auth";
import { markAdminBypass } from "@/server/admin-bypass";
import { markImpersonate } from "@/server/impersonation";
import { combineScopes, type Operation } from "@/auth/scope";
import { createDataExplorerRoutes, DataExplorerConfig } from "./data-explorer";
import { createTaskMonitorRoutes, TaskMonitorConfig } from "./task-monitor";
import { createKVInspectorRoutes, KVInspectorConfig } from "./kv-inspector";
import { layout } from "./html/layout";
import { runtimeScript } from "./html/client/runtime";
import { dataExplorerScript } from "./html/client/data-explorer-app";
import { htmxScript } from "./html/client/htmx-vendor";
import { logoSvg } from "./html/logo";
import * as pages from "./html/pages";
import { html, escapeHtml } from "./html/utils";
import { emptyState } from "./html/components";

export interface AdminUIConfig {
  basePath?: string;
  title?: string;
  metricsCollector?: {
    getRecent: (count: number) => any[];
    getSlow: (thresholdMs: number) => any[];
  };
  changelog?: {
    getCurrentSequence: () => Promise<number>;
    getEntries: (fromSeq: number, limit: number) => Promise<any[]>;
  };
  getActiveSubscriptions?: () => any[] | Promise<any[]>;
  disconnectSubscription?: (subscriptionId: string) => boolean | Promise<boolean>;
  userManager?: {
    listUsers: (limit?: number, offset?: number) => Promise<{ users: any[]; total: number }>;
    getUser: (id: string) => Promise<any | null>;
    createUser: (data: { email: string; name?: string; metadata?: any }) => Promise<any>;
    updateUser: (id: string, data: { email?: string; name?: string; metadata?: any }) => Promise<any>;
    deleteUser: (id: string) => Promise<void>;
  };
  sessionManager?: {
    listSessions: (limit?: number) => Promise<any[]>;
    getSessionsByUser: (userId: string) => Promise<any[]>;
    createSession: (userId: string, expiresIn?: number) => Promise<{ token: string; expiresAt: Date }>;
    revokeSession: (sessionId: string) => Promise<void>;
    revokeAllUserSessions: (userId: string) => Promise<number>;
  };
  // Pluggable persistence for the admin observability logs. Defaults to a
  // self-falling-back KV/in-memory hybrid; pass a custom adapter (e.g. one
  // backed by your database) to persist durably.
  observability?: {
    auditAdapter?: ObservabilityLogAdapter<AdminAuditEntry>;
    requestAdapter?: ObservabilityLogAdapter<RequestLog>;
    errorAdapter?: ObservabilityLogAdapter<ErrorLog>;
  };
  security?: AdminSecurityConfig;
  dataExplorer?: DataExplorerConfig;
  taskMonitor?: TaskMonitorConfig;
  kvInspector?: KVInspectorConfig;
}

interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  requestBody?: any;
  responseBody?: any;
  headers?: Record<string, string>;
  error?: string;
}

interface ErrorLog {
  id: string;
  timestamp: number;
  path: string;
  method: string;
  error: string;
  stack?: string;
  statusCode: number;
}

const MAX_LOGS = 500;
const MAX_AUDIT_EXPORT = 1000;

let requestLogAdapter: ObservabilityLogAdapter<RequestLog> = createKVLogAdapter<RequestLog>({
  maxEntries: MAX_LOGS,
  order: "newest-first",
  keyPrefix: "covara:obs:request",
});
let errorLogAdapter: ObservabilityLogAdapter<ErrorLog> = createKVLogAdapter<ErrorLog>({
  maxEntries: MAX_LOGS,
  order: "newest-first",
  keyPrefix: "covara:obs:error",
});

export const setRequestLogAdapter = (adapter: ObservabilityLogAdapter<RequestLog>): void => {
  requestLogAdapter = adapter;
};
export const setErrorLogAdapter = (adapter: ObservabilityLogAdapter<ErrorLog>): void => {
  errorLogAdapter = adapter;
};

export const logRequest = (log: RequestLog) => {
  requestLogAdapter.append(log);
};

export const logError = (log: ErrorLog) => {
  errorLogAdapter.append(log);
};

export interface AdminRequestLoggerOptions {
  // Path prefixes to exclude from the log (defaults to the admin UI itself so
  // it doesn't record its own traffic).
  skipPaths?: string[];
}

// Middleware that records each request into the admin dashboard's request/error
// log. `createCovara` mounts this automatically when the admin UI is enabled;
// mount it yourself (early, before your routes) when wiring the admin UI by hand.
export const createAdminRequestLogger = (
  options: AdminRequestLoggerOptions = {}
): MiddlewareHandler => {
  const skip = options.skipPaths ?? ["/__covara"];
  const reqId = (): string =>
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  return async (c, next) => {
    const start = Date.now();
    await next();
    const path = c.req.path;
    if (skip.some((p) => path.startsWith(p))) return;
    const status = c.res?.status ?? 0;
    const id = reqId();
    const timestamp = Date.now();
    logRequest({ id, method: c.req.method, path, status, duration: timestamp - start, timestamp });
    if (status >= 500) {
      logError({ id, timestamp, path, method: c.req.method, error: `HTTP ${status}`, statusCode: status });
    }
  };
};

export const createAdminUI = (config: AdminUIConfig = {}): Hono => {
  const router = new Hono();
  const basePath = config.basePath || "/__covara";
  const title = config.title || "Covara Admin";
  const mode = config.security?.mode ?? detectEnvironment();

  // Admin auth middleware for protected routes
  const adminAuth = createAdminAuthMiddleware(config.security ?? {});

  if (config.security?.auditSink) {
    setAdminAuditSink(config.security.auditSink);
  }

  if (config.observability?.auditAdapter) {
    setAdminAuditAdapter(config.observability.auditAdapter);
  }
  if (config.observability?.requestAdapter) {
    setRequestLogAdapter(config.observability.requestAdapter);
  }
  if (config.observability?.errorAdapter) {
    setErrorLogAdapter(config.observability.errorAdapter);
  }

  // The admin UI is a self-contained HTML app that loads its own (locally
  // served) scripts/styles and uses inline handlers. It serves no external
  // assets, so a self-only CSP is sufficient — and it must be set here so it
  // overrides the framework's strict API CSP (default-src 'none'), which would
  // otherwise block the admin UI's own scripts. `createSecurityHeaders` only
  // sets CSP when absent, so this wins for admin responses.
  const ADMIN_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  router.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", ADMIN_CSP);
  });

  // Gate the entire admin surface (UI pages, partials, and JSON APIs) behind
  // the admin auth check so it cannot be reached without passing authn/authz.
  router.use("/ui", adminAuth);
  router.use("/ui/*", adminAuth);
  router.use("/api", adminAuth);
  router.use("/api/*", adminAuth);
  router.use("/admin", adminAuth);
  router.use("/admin/*", adminAuth);

  // Mount sub-routers for new features
  if (config.dataExplorer?.enabled !== false) {
    const dataExplorerRouter = createDataExplorerRoutes(
      config.dataExplorer ?? {},
      config.security ?? {}
    );
    router.use("/api/explorer", adminAuth);
    router.use("/api/explorer/*", adminAuth);
    router.route("/api/explorer", dataExplorerRouter);
  }

  if (config.taskMonitor?.enabled) {
    const taskMonitorRouter = createTaskMonitorRoutes(config.taskMonitor);
    router.use("/api/tasks", adminAuth);
    router.use("/api/tasks/*", adminAuth);
    router.route("/api/tasks", taskMonitorRouter);
  }

  if (config.kvInspector?.enabled) {
    const kvInspectorRouter = createKVInspectorRoutes(
      config.kvInspector,
      config.security ?? {}
    );
    router.use("/api/kv", adminAuth);
    router.use("/api/kv/*", adminAuth);
    router.route("/api/kv", kvInspectorRouter);
  }

  // Admin audit log endpoint
  router.get("/api/admin-audit", adminAuth, async (c) => {
    const limit = parseInt(String(c.req.query("limit"))) || 100;
    const offset = parseInt(String(c.req.query("offset"))) || 0;
    const entries = await getAdminAuditLogAsync(limit, offset);
    return c.json({ entries, mode });
  });

  // Admin audit export endpoint
  router.get("/api/admin-audit/export", adminAuth, async (c) => {
    const format = c.req.query("format") || 'json';
    const entries = await getAdminAuditLogAsync(MAX_AUDIT_EXPORT, 0);

    if (format === 'csv') {
      const headers = ['timestamp', 'userId', 'userEmail', 'operation', 'resource', 'resourceId', 'reason'];
      const csvRows = [headers.join(',')];
      for (const entry of entries) {
        const row = headers.map(h => {
          const val = (entry as any)[h];
          if (val === undefined || val === null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        });
        csvRows.push(row.join(','));
      }
      c.header('Content-Type', 'text/csv');
      c.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
      return c.body(csvRows.join('\n'));
    } else {
      c.header('Content-Disposition', 'attachment; filename="audit-log.json"');
      return c.json(entries);
    }
  });

  // Canonical JSON audit export endpoint (authz-gated via /admin/* router.use above)
  router.get("/admin/audit/export", adminAuth, async (c) => {
    const entries = await getAdminAuditLogAsync(MAX_AUDIT_EXPORT, 0);
    c.header("Content-Disposition", 'attachment; filename="audit-log.json"');
    return c.json({ entries, mode, exportedAt: new Date().toISOString() });
  });

  // Environment info endpoint
  router.get("/api/environment", (c) => {
    const dataExplorerEnabled = config.dataExplorer?.enabled !== false;
    const dataExplorerReadOnly =
      config.dataExplorer?.readOnly ?? (mode === "production" ? true : false);

    return c.json({
      mode,
      version: readEnv("npm_package_version") ?? "unknown",
      features: {
        dataExplorer: dataExplorerEnabled,
        dataExplorerReadOnly,
        taskMonitor: config.taskMonitor?.enabled ?? false,
        kvInspector: config.kvInspector?.enabled ?? false,
        authRequired: config.security?.auth?.disabled !== true,
      },
    });
  });

  // API endpoints
  router.get("/api/resources", (c) => {
    const resources = getAllResourcesForDisplay();
    return c.json({ resources });
  });

  router.get("/api/metrics", (c) => {
    if (!config.metricsCollector) {
      return c.json({ metrics: [], enabled: false });
    }
    const recent = config.metricsCollector.getRecent(200);
    const slow = config.metricsCollector.getSlow(500);
    return c.json({ metrics: recent, slowQueries: slow, enabled: true });
  });

  router.get("/api/requests", (c) => {
    return c.json({ requests: requestLogAdapter.querySync({ limit: 200 }) });
  });

  router.get("/api/errors", (c) => {
    return c.json({ errors: errorLogAdapter.querySync({ limit: 100 }) });
  });

  router.get("/api/changelog", async (c) => {
    if (!config.changelog) {
      return c.json({ entries: [], currentSeq: 0, enabled: false });
    }
    try {
      const currentSeq = await config.changelog.getCurrentSequence();
      const entries = await config.changelog.getEntries(Math.max(0, currentSeq - 50), 50);
      return c.json({ entries, currentSeq, enabled: true });
    } catch {
      return c.json({ entries: [], currentSeq: 0, enabled: false });
    }
  });

  router.get("/api/subscriptions", async (c) => {
    if (!config.getActiveSubscriptions) {
      return c.json({ subscriptions: [], enabled: false });
    }
    return c.json({ subscriptions: await config.getActiveSubscriptions(), enabled: true });
  });

  router.delete("/api/subscriptions/:id", async (c) => {
    if (!config.disconnectSubscription) {
      return c.json({ error: "Subscription management not configured" }, 501);
    }
    try {
      const disconnected = await config.disconnectSubscription(c.req.param("id"));
      if (isHtmxRequest(c)) {
        // The Disconnect button swaps out its table row on success.
        return disconnected
          ? c.html("")
          : c.html(html`<tr><td colspan="7" class="alert alert-error">Subscription not found</td></tr>`);
      }
      if (!disconnected) {
        return c.json({ error: "Subscription not found" }, 404);
      }
      return c.body(null, 204);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  router.post("/api/query", async (c) => {
    const { resource, filter, limit = 10 } = (await readJsonBody(c)) as {
      resource?: string;
      filter?: string;
      limit?: number;
    };
    try {
      const url = `${resource}?filter=${encodeURIComponent(filter || "")}&limit=${limit}`;
      return c.json({ url, note: "Execute this query via the main API" });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // User management API endpoints
  router.get("/api/users", async (c) => {
    if (!config.userManager) {
      return c.json({ users: [], total: 0, enabled: false });
    }
    try {
      const limit = parseInt(String(c.req.query("limit"))) || 50;
      const offset = parseInt(String(c.req.query("offset"))) || 0;
      const result = await config.userManager.listUsers(limit, offset);
      return c.json({ ...result, enabled: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  router.get("/api/users/:id", async (c) => {
    if (!config.userManager) {
      return c.json({ error: "User management not configured" }, 501);
    }
    try {
      const userId = c.req.param("id");
      const user = await config.userManager.getUser(userId);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      return c.json({ user });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  router.post("/api/users", async (c) => {
    if (!config.userManager) {
      return c.json({ error: "User management not configured" }, 501);
    }
    try {
      const body = (await readFlexibleBody(c)) as { email: string; name?: string; metadata?: any };
      const user = await config.userManager.createUser(body);
      return c.json({ user }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  router.patch("/api/users/:id", async (c) => {
    if (!config.userManager) {
      return c.json({ error: "User management not configured" }, 501);
    }
    try {
      const userId = c.req.param("id");
      const body = (await readFlexibleBody(c)) as { email?: string; name?: string; metadata?: any };
      const user = await config.userManager.updateUser(userId, body);
      return c.json({ user });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  router.delete("/api/users/:id", async (c) => {
    if (!config.userManager) {
      return c.json({ error: "User management not configured" }, 501);
    }
    try {
      const userId = c.req.param("id");
      await config.userManager.deleteUser(userId);
      return c.body(null, 204);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // Session management API endpoints
  router.get("/api/sessions", async (c) => {
    if (!config.sessionManager) {
      return c.json({ sessions: [], enabled: false });
    }
    try {
      const limit = parseInt(String(c.req.query("limit"))) || 50;
      const sessions = (await config.sessionManager.listSessions(limit)).map(normalizeSession);
      return c.json({ sessions, enabled: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  router.get("/api/sessions/user/:userId", async (c) => {
    if (!config.sessionManager) {
      return c.json({ error: "Session management not configured" }, 501);
    }
    try {
      const userId = c.req.param("userId");
      const sessions = (await config.sessionManager.getSessionsByUser(userId)).map(normalizeSession);
      return c.json({ sessions });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  router.post("/api/sessions", async (c) => {
    if (!config.sessionManager) {
      return c.json({ error: "Session management not configured" }, 501);
    }
    try {
      const body = (await readFlexibleBody(c)) as {
        userId?: string;
        expiresIn?: number | string;
      };
      const htmx = isHtmxRequest(c);
      const userId = typeof body.userId === "string" ? body.userId : undefined;
      const expiresInRaw =
        body.expiresIn != null ? Number(body.expiresIn) : undefined;
      // The mint form sends the TTL in seconds; convert to ms for that path.
      // JSON API callers pass the value through unchanged.
      const expiresIn =
        expiresInRaw != null && !Number.isNaN(expiresInRaw)
          ? htmx
            ? expiresInRaw * 1000
            : expiresInRaw
          : undefined;
      if (!userId) {
        if (htmx) {
          return c.html(html`<div class="alert alert-error">userId is required</div>`);
        }
        return c.json({ error: "userId is required" }, 400);
      }
      const session = await config.sessionManager.createSession(userId, expiresIn);
      if (htmx) {
        const sessions = (await config.sessionManager.listSessions(100)).map(normalizeSession);
        return c.html(pages.sessionsList(sessions));
      }
      return c.json({ session }, 201);
    } catch (e: any) {
      if (isHtmxRequest(c)) {
        return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
      }
      return c.json({ error: e.message }, 400);
    }
  });

  router.delete("/api/sessions/:id", async (c) => {
    if (!config.sessionManager) {
      return c.json({ error: "Session management not configured" }, 501);
    }
    try {
      const sessionId = c.req.param("id");
      await config.sessionManager.revokeSession(sessionId);
      return c.body(null, 204);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  router.delete("/api/sessions/user/:userId", async (c) => {
    if (!config.sessionManager) {
      return c.json({ error: "Session management not configured" }, 501);
    }
    try {
      const userId = c.req.param("userId");
      const count = await config.sessionManager.revokeAllUserSessions(userId);
      return c.json({ revokedCount: count });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // Problem details documentation
  router.get("/problems/:type", (c) => {
    const problemDocs: Record<string, { title: string; description: string; solutions: string[] }> = {
      "not-found": {
        title: "Resource Not Found",
        description: "The requested resource does not exist or you do not have permission to access it.",
        solutions: [
          "Verify the resource ID is correct",
          "Check that the resource exists in the database",
          "Ensure you have read permissions for this resource",
          "If using auth scopes, verify your scope includes this resource"
        ]
      },
      "validation-error": {
        title: "Validation Error",
        description: "The request body failed validation against the schema.",
        solutions: [
          "Check the required fields are present",
          "Verify field types match the schema",
          "Review the 'errors' array in the response for specific issues",
          "Use the Schema Viewer to see field requirements"
        ]
      },
      "unauthorized": {
        title: "Unauthorized",
        description: "Authentication is required to access this resource.",
        solutions: [
          "Include a valid authentication token",
          "Check if your session has expired",
          "Verify the auth middleware is configured correctly"
        ]
      },
      "forbidden": {
        title: "Forbidden",
        description: "You do not have permission to perform this operation.",
        solutions: [
          "Check your user role and permissions",
          "Verify the auth scope allows this operation",
          "Contact an administrator for access"
        ]
      },
      "rate-limit-exceeded": {
        title: "Rate Limit Exceeded",
        description: "Too many requests in the current time window.",
        solutions: [
          "Wait before making more requests",
          "Check the Retry-After header for wait time",
          "Consider implementing request batching",
          "Review rate limit configuration"
        ]
      },
      "batch-limit-exceeded": {
        title: "Batch Limit Exceeded",
        description: "The batch operation exceeds the configured limit.",
        solutions: [
          "Reduce the number of items in the batch",
          "Check the batch limits in resource configuration",
          "Split the operation into multiple smaller batches"
        ]
      },
      "filter-parse-error": {
        title: "Filter Parse Error",
        description: "The filter expression could not be parsed.",
        solutions: [
          "Check the filter syntax",
          "Use the Filter Tester to validate expressions",
          "Ensure strings are properly quoted",
          "Review supported operators"
        ]
      },
      "internal-error": {
        title: "Internal Server Error",
        description: "An unexpected error occurred on the server.",
        solutions: [
          "Check the server logs for details",
          "Review the Error Log in the admin panel",
          "If the issue persists, report it with the request ID"
        ]
      },
      "conflict": {
        title: "Conflict",
        description: "The request conflicts with the current state of the resource.",
        solutions: [
          "Check if the resource was modified by another request",
          "Refetch the resource and retry",
          "Use ETag headers for optimistic concurrency control"
        ]
      },
      "precondition-failed": {
        title: "Precondition Failed",
        description: "The resource was modified since you last fetched it (ETag mismatch).",
        solutions: [
          "Refetch the resource to get the latest ETag",
          "Update your If-Match header with the new ETag",
          "Retry the operation with the updated data"
        ]
      },
      "cursor-invalid": {
        title: "Invalid Cursor",
        description: "The pagination cursor is malformed or incompatible.",
        solutions: [
          "Request a fresh first page without a cursor",
          "Ensure the cursor was not modified",
          "Check if the orderBy parameters match the original request",
          "Verify the API version matches the cursor version"
        ]
      },
      "cursor-expired": {
        title: "Cursor Expired",
        description: "The pagination cursor has expired and can no longer be used.",
        solutions: [
          "Request a fresh first page without a cursor",
          "Cursors expire after a period of inactivity",
          "Consider caching results if pagination takes a long time"
        ]
      },
      "idempotency-mismatch": {
        title: "Idempotency Mismatch",
        description: "The idempotency key was already used with different request parameters.",
        solutions: [
          "Use a new unique idempotency key for different requests",
          "If retrying the same request, ensure body and path match exactly",
          "Idempotency keys are tied to specific request signatures"
        ]
      },
      "unsupported-version": {
        title: "Unsupported Client Version",
        description: "The client version is below the minimum supported version.",
        solutions: [
          "Upgrade your client library to a newer version",
          "Check the minVersion field in the response",
          "Review the changelog for breaking changes"
        ]
      },
      "unknown-error": {
        title: "Unknown Error",
        description: "An unrecognized error occurred.",
        solutions: [
          "Check the server logs for details",
          "Review the request ID in the response",
          "Contact support with the error details"
        ]
      }
    };

    const problemType = c.req.param("type");
    const doc = problemDocs[problemType] || {
      title: "Unknown Error",
      description: "An unrecognized error type.",
      solutions: ["Check the API documentation", "Review server logs"]
    };

    return c.json(doc);
  });

  // Helper to get layout props
  const getLayoutProps = (activePage: string) => ({
    title,
    mode,
    activePage,
  });

  // Helper to check if this is an HTMX request
  const isHtmxRequest = (c: Context) => c.req.header('hx-request') === 'true';

  // Read a request body whether it arrives as JSON or as a form submission
  // (HTMX forms post application/x-www-form-urlencoded by default).
  const readFlexibleBody = async (c: Context): Promise<Record<string, any>> => {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await readJsonBody(c)) as Record<string, any>;
    }
    if (
      contentType.includes("form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      return (await c.req.parseBody()) as Record<string, any>;
    }
    try {
      return (await readJsonBody(c)) as Record<string, any>;
    } catch {
      return (await c.req.parseBody()) as Record<string, any>;
    }
  };

  // Normalize whatever shape a sessionManager returns into the canonical
  // SessionInfo the admin pages render. Accepts common field aliases
  // (id/sessionToken/token, expiresAt/expires) so any session store works.
  const toIso = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return new Date(v).toISOString();
    return String(v);
  };
  const normalizeSession = (s: any): pages.SessionInfo => ({
    ...s,
    id: s?.id ?? s?.sessionToken ?? s?.token ?? "",
    userId: s?.userId ?? "",
    createdAt: toIso(s?.createdAt) ?? "",
    expiresAt: toIso(s?.expiresAt ?? s?.expires) ?? "",
    // Activity metadata is captured into session.data by the auth layer
    // (login stamps ip/user-agent; getSession stamps lastActiveAt).
    lastActiveAt: toIso(s?.lastActiveAt ?? s?.data?.lastActiveAt),
    ipAddress: s?.ipAddress ?? s?.data?.ipAddress,
    userAgent: s?.userAgent ?? s?.data?.userAgent,
  });

  // The changelog system stores `{type, objectId, object, previousObject}`;
  // the admin pages render `{operation, recordId, after, before}`. Accept both
  // shapes so custom `config.changelog` providers keep working.
  const normalizeChangelogEntry = (e: any): pages.ChangelogEntry => ({
    ...e,
    operation: e?.operation ?? e?.type ?? "update",
    recordId: e?.recordId ?? e?.objectId ?? "",
    before: e?.before ?? e?.previousObject,
    after: e?.after ?? e?.object,
  });

  // Build the API explorer's endpoint catalog. The path uses each resource's
  // captured mount path (e.g. "/api/todos") so the explorer's test runner hits
  // the real endpoint; it falls back to "/<name>" before the resource is first
  // requested (mount paths are captured lazily on the first hit).
  const buildApiEndpoints = (): pages.EndpointInfo[] => {
    const endpoints: pages.EndpointInfo[] = [];
    for (const resource of getAllResourcesForDisplay()) {
      const caps = resource.capabilities || {};
      const base = resource.mountPath ?? `/${resource.name}`;

      endpoints.push({
        method: "GET",
        path: base,
        description: `List ${resource.name} with filtering and pagination`,
        parameters: [
          { name: "filter", in: "query", type: "string", description: "RSQL filter expression" },
          { name: "limit", in: "query", type: "number", description: "Max results (default: 50)" },
          { name: "cursor", in: "query", type: "string", description: "Pagination cursor" },
          { name: "orderBy", in: "query", type: "string", description: "Sort field:direction" },
        ],
      });

      endpoints.push({
        method: "GET",
        path: `${base}/:id`,
        description: `Get a single ${resource.name} by ID`,
        parameters: [{ name: "id", in: "path", type: "string", required: true }],
      });

      if (caps.enableCreate) {
        endpoints.push({
          method: "POST",
          path: base,
          description: `Create a new ${resource.name}`,
          requestBody: { contentType: "application/json" },
        });
      }

      if (caps.enableUpdate) {
        endpoints.push({
          method: "PATCH",
          path: `${base}/:id`,
          description: `Update a ${resource.name}`,
          parameters: [{ name: "id", in: "path", type: "string", required: true }],
          requestBody: { contentType: "application/json" },
        });
      }

      if (caps.enableDelete) {
        endpoints.push({
          method: "DELETE",
          path: `${base}/:id`,
          description: `Delete a ${resource.name}`,
          parameters: [{ name: "id", in: "path", type: "string", required: true }],
        });
      }
    }
    return endpoints;
  };

  // Helper to send HTML response (full page or fragment for HTMX)
  const sendHtml = (c: Context, activePage: string, content: string) => {
    if (isHtmxRequest(c)) {
      return c.html(content);
    }
    return c.html(layout(getLayoutProps(activePage), content));
  };

  // ============================================
  // Client runtime assets (served as JS)
  // ============================================
  const sendJs = (c: Context, body: string) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(body);
  };
  router.get("/ui/htmx.js", (c) => sendJs(c, htmxScript));
  router.get("/ui/covara-runtime.js", (c) => sendJs(c, runtimeScript));
  router.get("/ui/data-explorer-app.js", (c) => sendJs(c, dataExplorerScript));

  // Logo / favicon — served outside the auth gate so the favicon also shows on
  // the login challenge page.
  router.get("/logo.svg", (c) => {
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(logoSvg);
  });

  // ============================================
  // HTMX UI Routes - Full Page Renders
  // ============================================

  // Dashboard
  router.get("/ui", async (c) => {
    const resources = getAllResourcesForDisplay();
    const recentRequests = requestLogAdapter.querySync({ limit: 10 }).map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
    }));

    let currentSeq = 0;
    let changelogCount = 0;
    if (config.changelog) {
      try {
        currentSeq = await config.changelog.getCurrentSequence();
        changelogCount = currentSeq;
      } catch {}
    }

    const subscriptions = (await config.getActiveSubscriptions?.()) || [];

    const content = pages.dashboardPage({
      stats: {
        resources: resources.length,
        requests: requestLogAdapter.countSync(),
        errors: errorLogAdapter.countSync(),
        subscriptions: subscriptions.length,
        changelog: changelogCount,
      },
      recentRequests,
      mode,
    });

    return sendHtml(c, 'dashboard', content);
  });

  router.get("/ui/dashboard", (c) => {
    // Redirect to main UI
    return c.redirect(`${basePath}/ui`, 302);
  });

  // Resources
  router.get("/ui/resources", (c) => {
    const resources = getAllResourcesForDisplay();
    const content = pages.resourcesPage({ resources });
    return sendHtml(c, 'resources', content);
  });

  // Data Explorer
  router.get("/ui/data-explorer", (c) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    const content = pages.dataExplorerPage({
      resources,
      readOnly,
      mode,
    });

    return sendHtml(c, 'data-explorer', content);
  });

  // Requests
  router.get("/ui/requests", (c) => {
    const requests = requestLogAdapter.querySync({ limit: 200 }).map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
      error: r.error,
    }));

    const content = pages.requestsPage({ requests });
    return sendHtml(c, 'requests', content);
  });

  // Errors
  router.get("/ui/errors", (c) => {
    const errors = errorLogAdapter.querySync({ limit: 100 }).map(e => ({
      id: e.id,
      status: e.statusCode,
      path: e.path,
      message: e.error,
      stack: e.stack,
      timestamp: new Date(e.timestamp).toISOString(),
    }));

    const content = pages.errorsPage({ errors });
    return sendHtml(c, 'errors', content);
  });

  // Users
  router.get("/ui/users", async (c) => {
    let users: any[] = [];
    let totalCount = 0;

    if (config.userManager) {
      try {
        const result = await config.userManager.listUsers(50, 0);
        users = result.users;
        totalCount = result.total;
      } catch {}
    }

    const content = pages.usersPage({ users, totalCount });
    return sendHtml(c, 'users', content);
  });

  // Sessions
  router.get("/ui/sessions", async (c) => {
    let sessions: any[] = [];

    if (config.sessionManager) {
      try {
        sessions = (await config.sessionManager.listSessions(100)).map(normalizeSession);
      } catch {}
    }

    const content = pages.sessionsPage({
      sessions,
      totalCount: sessions.length,
    });

    return sendHtml(c, 'sessions', content);
  });

  // Subscriptions
  router.get("/ui/subscriptions", async (c) => {
    const subscriptions = (await config.getActiveSubscriptions?.()) || [];

    const byResource: Record<string, number> = {};
    for (const sub of subscriptions) {
      byResource[sub.resource] = (byResource[sub.resource] || 0) + 1;
    }

    const content = pages.subscriptionsPage({
      subscriptions,
      stats: {
        active: subscriptions.length,
        totalEvents: subscriptions.reduce((sum: number, s: any) => sum + (s.eventCount || 0), 0),
        byResource,
      },
    });

    return sendHtml(c, 'subscriptions', content);
  });

  // Changelog
  router.get("/ui/changelog", async (c) => {
    let entries: any[] = [];
    const stats = { total: 0, creates: 0, updates: 0, deletes: 0, currentSeq: 0 };

    if (config.changelog) {
      try {
        stats.currentSeq = await config.changelog.getCurrentSequence();
        entries = (
          await config.changelog.getEntries(Math.max(0, stats.currentSeq - 100), 100)
        ).map(normalizeChangelogEntry);
        stats.total = entries.length;
        for (const e of entries) {
          if (e.operation === 'create') stats.creates++;
          else if (e.operation === 'update') stats.updates++;
          else if (e.operation === 'delete') stats.deletes++;
        }
      } catch {}
    }

    const content = pages.changelogPage({ entries, stats });
    return sendHtml(c, 'changelog', content);
  });

  // Tasks
  router.get("/ui/tasks", async (c) => {
    const content = pages.tasksPage({
      stats: { pending: 0, scheduled: 0, running: 0, completed: 0, failed: 0, dlq: 0 },
      scheduled: [],
      dlq: [],
      workers: [],
    });

    return sendHtml(c, 'tasks', content);
  });

  // KV Inspector
  router.get("/ui/kv-inspector", (c) => {
    const enabled = config.kvInspector?.enabled ?? false;
    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    const content = pages.kvInspectorPage({ enabled, readOnly, mode });
    return sendHtml(c, 'kv-inspector', content);
  });

  // Admin Audit
  router.get("/ui/admin-audit", (c) => {
    const entries = getAdminAuditLog(100, 0);

    const content = pages.adminAuditPage({ entries });
    return sendHtml(c, 'admin-audit', content);
  });

  // Filter Tester
  router.get("/ui/filter-tester", (c) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);

    const content = pages.filterTesterPage({ resources });
    return sendHtml(c, 'filter-tester', content);
  });

  // API Explorer
  router.get("/ui/api-explorer", (c) => {
    const content = pages.apiExplorerPage({ endpoints: buildApiEndpoints(), baseUrl: '' });
    return sendHtml(c, 'api-explorer', content);
  });

  // ============================================
  // HTMX Partial Routes - For dynamic updates
  // ============================================

  // Empty fragment (for closing modals, etc.)
  router.get("/ui/empty", (c) => {
    return c.html('');
  });

  // Request list partial
  router.get("/ui/requests/list", (c) => {
    let requests = requestLogAdapter.querySync({ limit: 200 });

    const method = c.req.query("method");
    const status = c.req.query("status");
    const path = c.req.query("path");

    if (method) {
      requests = requests.filter(r => r.method === method);
    }
    if (status === 'success') {
      requests = requests.filter(r => r.status >= 200 && r.status < 400);
    } else if (status === 'error') {
      requests = requests.filter(r => r.status >= 400);
    }
    if (path) {
      requests = requests.filter(r => r.path.includes(path));
    }

    const mapped = requests.map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
      error: r.error,
    }));

    return c.html(pages.requestList(mapped));
  });

  // Request detail partial
  router.get("/ui/requests/:id", (c) => {
    const id = c.req.param("id");
    const request = requestLogAdapter.querySync().find(r => r.id === id);

    if (!request) {
      return c.html(emptyState('✕', 'Request not found', 'The request may have been purged from logs'));
    }

    return c.html(pages.requestDetail({
      request: {
        id: request.id,
        method: request.method,
        path: request.path,
        status: request.status,
        duration: request.duration,
        timestamp: new Date(request.timestamp).toISOString(),
        error: request.error,
        headers: request.headers,
        body: request.requestBody,
        response: request.responseBody,
      },
    }));
  });

  // Users list partial
  router.get("/ui/users/list", async (c) => {
    if (!config.userManager) {
      return c.html(pages.usersList([]));
    }

    try {
      const search = c.req.query("search");
      const result = await config.userManager.listUsers(50, 0);
      let users = result.users;

      if (search) {
        const term = search.toLowerCase();
        users = users.filter((u: any) =>
          u.email?.toLowerCase().includes(term) ||
          u.name?.toLowerCase().includes(term)
        );
      }

      return c.html(pages.usersList(users));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // User create form partial
  router.get("/ui/users/new", (c) => {
    return c.html(pages.userForm());
  });

  // User detail partial
  router.get("/ui/users/:id", async (c) => {
    if (!config.userManager) {
      return c.html(emptyState('✕', 'User management not configured', ''));
    }

    try {
      const id = c.req.param("id");
      const user = await config.userManager.getUser(id);

      if (!user) {
        return c.html(emptyState('✕', 'User not found', ''));
      }

      let sessions: any[] = [];
      if (config.sessionManager) {
        try {
          sessions = (await config.sessionManager.getSessionsByUser(id)).map(normalizeSession);
        } catch {}
      }

      return c.html(pages.userDetail({ user: { ...user, sessions } }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Session create form partial
  router.get("/ui/sessions/new", async (c) => {
    let users: { id: string; email: string }[] = [];

    if (config.userManager) {
      try {
        const result = await config.userManager.listUsers(100, 0);
        users = result.users.map((u: any) => ({ id: u.id, email: u.email }));
      } catch {}
    }

    return c.html(pages.sessionForm({ users }));
  });

  // Sessions list partial
  router.get("/ui/sessions/list", async (c) => {
    if (!config.sessionManager) {
      return c.html(pages.sessionsList([]));
    }

    try {
      const sessions = (await config.sessionManager.listSessions(100)).map(normalizeSession);
      return c.html(pages.sessionsList(sessions));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Subscriptions list partial
  router.get("/ui/subscriptions/list", async (c) => {
    const subscriptions = (await config.getActiveSubscriptions?.()) || [];
    return c.html(pages.subscriptionsList(subscriptions));
  });

  // Changelog list partial
  router.get("/ui/changelog/list", async (c) => {
    if (!config.changelog) {
      return c.html(pages.changelogList([]));
    }

    try {
      const resource = c.req.query("resource");
      const fromSeq = parseInt(c.req.query("fromSeq") ?? "") || 0;

      const currentSeq = await config.changelog.getCurrentSequence();
      let entries = await config.changelog.getEntries(fromSeq || Math.max(0, currentSeq - 100), 100);

      if (resource) {
        entries = entries.filter((e: any) => e.resource?.includes(resource));
      }

      return c.html(pages.changelogList(entries.map(normalizeChangelogEntry)));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Changelog detail partial
  router.get("/ui/changelog/:seq", async (c) => {
    if (!config.changelog) {
      return c.html(emptyState('✕', 'Changelog not configured', ''));
    }

    try {
      const seq = parseInt(c.req.param("seq"));
      const entries = await config.changelog.getEntries(seq, 1);
      const entry = entries[0];

      if (!entry) {
        return c.html(emptyState('✕', 'Entry not found', ''));
      }

      return c.html(pages.changelogDetail({ entry: normalizeChangelogEntry(entry) }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Audit list partial
  router.get("/ui/audit/list", (c) => {
    let entries = getAdminAuditLog(100, 0);

    const operation = c.req.query("operation");
    const user = c.req.query("user");

    if (operation) {
      entries = entries.filter(e => e.operation?.includes(operation));
    }
    if (user) {
      entries = entries.filter(e =>
        e.userEmail?.toLowerCase().includes(user.toLowerCase()) ||
        e.userId?.includes(user)
      );
    }

    return c.html(pages.auditList(entries));
  });

  // Audit detail partial
  router.get("/ui/audit/:index", (c) => {
    const index = parseInt(c.req.param("index"));
    const entries = getAdminAuditLog(100, 0);
    const entry = entries[index];

    if (!entry) {
      return c.html(emptyState('✕', 'Entry not found', ''));
    }

    return c.html(pages.auditDetail({ entry }));
  });

  // KV keys partial
  router.get("/ui/kv/keys", (c) => {
    if (!config.kvInspector?.enabled) {
      return c.html(emptyState('⛁', 'KV Inspector Disabled', ''));
    }

    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    // This would need to be implemented with actual KV access
    // For now, return empty
    return c.html(pages.kvKeysList({ keys: [], readOnly }));
  });

  // KV value partial
  router.get("/ui/kv/value/:key", (c) => {
    if (!config.kvInspector?.enabled) {
      return c.html(emptyState('⛁', 'KV Inspector Disabled', ''));
    }

    const key = decodeURIComponent(c.req.param("key"));
    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    // This would need to be implemented with actual KV access
    return c.html(pages.kvValueView({
      key,
      type: 'string',
      value: '',
      readOnly,
    }));
  });

  // Data explorer partials
  router.get("/ui/data/resources", (c) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    return c.html(pages.resourceSelector({ resources, readOnly }));
  });

  // Data table partial for a resource
  router.get("/ui/data/:resource/table", async (c) => {
    const resource = c.req.param("resource");
    const filter = c.req.query("filter") || '';
    const limit = parseInt(c.req.query("limit") ?? "") || 50;
    const cursor = c.req.query("cursor") || '';
    const orderBy = c.req.query("orderBy") || '';
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    try {
      const schemaInfo = getSchemaInfo(resource);

      if (!schemaInfo) {
        return c.html(emptyState('✕', 'Resource not found', `Resource '${resource}' is not registered`));
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        return c.html(emptyState('✕', 'Resource not found', ''));
      }

      const db = entry.db;
      const schema = entry.schema;
      const idColumnName = entry.idColumn.name;

      const filterer = createResourceFilter(schema, {});
      const pagination = createPagination(schema, entry.idColumn, {
        defaultLimit: 20,
        maxLimit: config.dataExplorer?.maxLimit ?? 100,
      });

      const orderByFields = parseOrderBy(orderBy || idColumnName);

      let sqlFilter: any;
      if (filter) {
        sqlFilter = filterer.convert(filter);
      }

      let query = db.select().from(schema);
      if (sqlFilter) {
        query = query.where(sqlFilter);
      }

      if (cursor) {
        const cursorData = decodeCursorLegacy(cursor);
        if (cursorData) {
          const cursorCondition = pagination.buildCursorCondition(cursorData, orderByFields);
          if (cursorCondition) {
            query = query.where(sqlFilter ? and(sqlFilter, cursorCondition) : cursorCondition);
          }
        }
      }

      const orderByClauses = pagination.buildOrderBy(orderByFields);
      if (orderByClauses.length > 0) {
        query = query.orderBy(...orderByClauses);
      }

      query = query.limit(limit + 1);
      const items = await query;

      // Get total count
      const [countResult] = await db
        .select({ count: count() })
        .from(schema)
        .where(sqlFilter);
      const totalCount = countResult?.count ?? 0;

      const result = pagination.processResults(
        items as Record<string, unknown>[],
        limit,
        idColumnName,
        orderByFields,
        totalCount
      );

      return c.html(pages.dataTable({
        resource,
        schema: schemaInfo,
        items: result.items,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor ?? undefined,
        filter,
        orderBy: orderBy || undefined,
        limit,
        readOnly,
      }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Row detail partial
  router.get("/ui/data/:resource/row/:id", async (c) => {
    const resource = c.req.param("resource");
    const id = c.req.param("id");

    try {
      const entry = getResourceSchema(resource);
      if (!entry) {
        return c.html(emptyState('✕', 'Resource not found', ''));
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        return c.html(emptyState('✕', 'Record not found', ''));
      }

      return c.html(pages.recordDetail({ resource, item: item as Record<string, unknown> }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Edit form partial
  router.get("/ui/data/:resource/edit/:id", async (c) => {
    const resource = c.req.param("resource");
    const id = c.req.param("id");
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    if (readOnly) {
      return c.html(emptyState('⚠', 'Read-only mode', 'Data editing is disabled in this environment'));
    }

    try {
      const entry = getResourceSchema(resource);
      const schemaInfo = getSchemaInfo(resource);
      if (!entry || !schemaInfo) {
        return c.html(emptyState('✕', 'Resource not found', ''));
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        return c.html(emptyState('✕', 'Record not found', ''));
      }

      return c.html(pages.recordForm({
        resource,
        schema: schemaInfo,
        item: item as Record<string, unknown>,
        isEdit: true,
      }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // New record form partial
  router.get("/ui/data/new", (c) => {
    const resource = c.req.query("resource");
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    if (readOnly) {
      return c.html(emptyState('⚠', 'Read-only mode', 'Data editing is disabled in this environment'));
    }

    if (!resource) {
      return c.html(emptyState('⚠', 'No resource selected', 'Select a resource first'));
    }

    try {
      const schemaInfo = getSchemaInfo(resource);

      if (!schemaInfo) {
        return c.html(emptyState('✕', 'Resource not found', ''));
      }

      return c.html(pages.recordForm({
        resource,
        schema: schemaInfo,
        isEdit: false,
      }));
    } catch (e: any) {
      return c.html(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Filter tester parse partial
  router.post("/ui/filter/parse", async (c) => {
    const body = await c.req.parseBody();
    const filter = typeof body.filter === "string" ? body.filter : '';

    try {
      // Use createResourceFilter with a minimal dummy to parse the filter
      // This validates the syntax without needing a real schema
      const dummySchema = {} as any;
      const filterer = createResourceFilter(dummySchema, {});
      // compile() returns the parsed AST and throws on syntax errors
      const ast = filterer.compile(filter);

      return c.html(pages.filterParseResult({ filter, ast: ast.toString() }));
    } catch (e: any) {
      return c.html(pages.filterParseResult({ filter, error: e.message }));
    }
  });

  // API explorer endpoint detail partial
  router.get("/ui/api-explorer/endpoint/:index", (c) => {
    const index = parseInt(c.req.param("index"));
    const endpoint = buildApiEndpoints()[index];
    if (!endpoint) {
      return c.html(emptyState('✕', 'Endpoint not found', ''));
    }

    return c.html(pages.endpointDetail({ endpoint, baseUrl: '' }));
  });

  // API explorer request runner — performs the configured request against this
  // same server (forwarding the caller's cookies for auth) and renders the
  // response. The form posts method/path plus param_<name> fields and a body.
  router.post("/ui/api-explorer/execute", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const method = (body.method ?? "GET").toUpperCase();
    let path = body.path ?? "";
    const requestBody = typeof body.body === "string" ? body.body.trim() : "";

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith("param_")) continue;
      if (value == null || value === "") continue;
      const paramName = key.slice("param_".length);
      if (path.includes(`:${paramName}`)) {
        path = path.replace(`:${paramName}`, encodeURIComponent(value));
      } else {
        query.set(paramName, value);
      }
    }

    const origin = new URL(c.req.url).origin;
    const qs = query.toString();
    const target = `${origin}${path.startsWith("/") ? "" : "/"}${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {};
    const cookie = c.req.header("cookie");
    if (cookie) headers["cookie"] = cookie;
    const auth = c.req.header("authorization");
    if (auth) headers["authorization"] = auth;

    // A verified admin running a request through the explorer either
    // impersonates a user (runs under THAT user's scope, read-write) or, by
    // default, bypasses scopes entirely. Both marker headers carry no secret:
    // the resource layer re-verifies that the forwarded request's authenticated
    // user is an admin before honoring either, so a leaked marker is worthless
    // to a non-admin. Impersonation replaces bypass; the two never stack.
    const adminUser = getAdminUser(c);
    const impersonateId =
      typeof body.impersonate_user_id === "string"
        ? body.impersonate_user_id.trim()
        : "";
    if (adminUser && impersonateId) {
      Object.assign(headers, markImpersonate(impersonateId));
      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "impersonate_execute",
        reason: `Impersonating ${impersonateId}: ${method} ${path}`,
        details: { impersonatedUserId: impersonateId, method, path },
      });
    } else if (adminUser) {
      Object.assign(headers, markAdminBypass());
      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "api_explorer_execute",
        reason: `Admin scope bypass: ${method} ${path}`,
      });
    }

    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && requestBody) {
      headers["content-type"] = "application/json";
      init.body = requestBody;
    }

    const started = Date.now();
    try {
      const res = await fetch(target, init);
      const duration = Date.now() - started;
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });
      return c.html(
        pages.apiResponse({
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          body: parsed,
          duration,
        })
      );
    } catch (e: any) {
      return c.html(
        pages.apiResponse({
          status: 0,
          statusText: "Request Failed",
          headers: {},
          body: "",
          duration: Date.now() - started,
          error: e?.message ?? String(e),
        })
      );
    }
  });

  // Impersonation scope preview — resolves the auth scope a given user's
  // request would carry for a resource+operation, so the explorers can show
  // "appending filter userId==..." badges. Read-only; gated by adminAuth.
  const OPERATIONS: Operation[] = ["read", "create", "update", "delete", "subscribe"];
  router.get("/api/impersonation/scope", async (c) => {
    const resource = c.req.query("resource") ?? "";
    const operation = (c.req.query("operation") ?? "read") as Operation;
    const userId = c.req.query("userId") ?? "";

    if (!OPERATIONS.includes(operation)) {
      return c.json({ error: `Invalid operation: ${operation}` }, 400);
    }
    const resolver = getResourceScopeResolver(resource);
    if (!resolver) {
      return c.json({ error: `Unknown resource: ${resource}` }, 404);
    }
    if (!config.userManager) {
      return c.json({ error: "User management not configured" }, 404);
    }
    const u = await config.userManager.getUser(userId);
    if (!u) {
      return c.json({ error: `Unknown user: ${userId}` }, 404);
    }
    const user = {
      id: String(u.id),
      email: u.email ?? null,
      name: u.name ?? null,
      image: u.image ?? null,
      emailVerified: u.emailVerified ?? null,
      sessionId: "impersonation",
      sessionExpiresAt: new Date(0),
      metadata: u.metadata ?? undefined,
    };

    if (resolver.isPublic(operation)) {
      return c.json({ resource, operation, userId, scope: "*", public: true, denied: false });
    }
    try {
      const scope = await resolver.resolve(operation, user);
      if (scope.isEmpty()) {
        return c.json({ resource, operation, userId, scope: "", denied: true });
      }
      return c.json({
        resource,
        operation,
        userId,
        scope: scope.toString(),
        filter: combineScopes(scope, ""),
        denied: false,
      });
    } catch (e: any) {
      return c.json({ resource, operation, userId, scope: "", denied: true, reason: e?.message ?? "denied" });
    }
  });

  // Filter tester — run an RSQL expression against a resource's live data
  // (in-memory matching, so it exercises the same predicate logic used for
  // subscription matching) and report which records match.
  router.post("/ui/filter/test", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const filter = typeof body.filter === "string" ? body.filter : "";
    const resource = typeof body.resource === "string" ? body.resource : "";

    if (!resource) {
      return c.html(
        pages.filterTestResult({
          filter,
          resource,
          matchCount: 0,
          totalCount: 0,
          matches: [],
          executionTime: 0,
          error: "Select a resource to test against",
        })
      );
    }

    const entry = getResourceSchema(resource);
    if (!entry) {
      return c.html(
        pages.filterTestResult({
          filter,
          resource,
          matchCount: 0,
          totalCount: 0,
          matches: [],
          executionTime: 0,
          error: `Unknown resource: ${resource}`,
        })
      );
    }

    const started = Date.now();
    try {
      const rows = (await (entry.db as any)
        .select()
        .from(entry.schema)
        .limit(500)) as Record<string, unknown>[];
      const filterer = createResourceFilter(entry.schema, {});

      // When impersonating, AND the impersonated user's read scope into the
      // tested filter so the result reflects what that user would actually see.
      let effectiveFilter = filter;
      let scopeDenied = false;
      const impersonateId =
        typeof body.impersonate_user_id === "string"
          ? body.impersonate_user_id.trim()
          : "";
      if (getAdminUser(c) && impersonateId && config.userManager) {
        const resolver = getResourceScopeResolver(resource);
        const u = await config.userManager.getUser(impersonateId);
        if (resolver && u && !resolver.isPublic("read")) {
          const scope = await resolver.resolve("read", {
            id: String(u.id),
            email: u.email ?? null,
            name: u.name ?? null,
            image: u.image ?? null,
            emailVerified: u.emailVerified ?? null,
            sessionId: "impersonation",
            sessionExpiresAt: new Date(0),
            metadata: u.metadata ?? undefined,
          });
          if (scope.isEmpty()) {
            scopeDenied = true;
          } else {
            effectiveFilter = combineScopes(scope, filter);
          }
        }
      }

      const matches = scopeDenied
        ? []
        : effectiveFilter
          ? rows.filter((row) => filterer.execute(effectiveFilter, row as any))
          : rows;
      return c.html(
        pages.filterTestResult({
          filter,
          resource,
          matchCount: matches.length,
          totalCount: rows.length,
          matches: matches.slice(0, 50),
          executionTime: Date.now() - started,
        })
      );
    } catch (e: any) {
      return c.html(
        pages.filterTestResult({
          filter,
          resource,
          matchCount: 0,
          totalCount: 0,
          matches: [],
          executionTime: Date.now() - started,
          error: e?.message ?? String(e),
        })
      );
    }
  });

  return router;
};

export default createAdminUI;
