import type { Context, MiddlewareHandler } from "hono";
import { getClientIP } from "@/server/request";
import { readEnv } from "@/server/env";
import { getUser } from "@/server/context";
import { UnauthorizedError } from "@/resource/error";
import type { UserContext } from "@/resource/types";
import {
  createKVLogAdapter,
  type ObservabilityLogAdapter,
} from "@/observability/log-adapter";
import { hasGlobalKV, getGlobalKV } from "@/kv";

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    adminUser?: AdminUser;
  }
}

export type EnvironmentMode = "development" | "staging" | "production";

export type AdminAuthorizeFn = (
  user: AdminUser,
  c: Context
) => boolean | Promise<boolean>;

export type AdminCanFn = (
  user: AdminUser,
  action: string,
  resource: string
) => boolean | Promise<boolean>;

export interface AdminSecurityConfig {
  mode?: EnvironmentMode;

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

  requireRole?: string | string[];

  authorize?: AdminAuthorizeFn;

  can?: AdminCanFn;

  auditSink?: (entry: AdminAuditEntry) => void | Promise<void>;

  allowedIPs?: string[];

  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") return [value];
  return [];
};

export const extractUserRoles = (user: {
  roles?: unknown;
  role?: unknown;
  metadata?: Record<string, unknown> | null;
} | null | undefined): string[] => {
  if (!user) return [];
  const roles = new Set<string>();
  for (const role of toStringArray(user.roles)) roles.add(role);
  for (const role of toStringArray(user.role)) roles.add(role);
  const metadata = user.metadata ?? undefined;
  if (metadata) {
    for (const role of toStringArray(metadata.roles)) roles.add(role);
    for (const role of toStringArray(metadata.role)) roles.add(role);
  }
  return [...roles];
};

export const extractUserPermissions = (user: {
  permissions?: unknown;
  metadata?: Record<string, unknown> | null;
} | null | undefined): string[] => {
  if (!user) return [];
  const perms = new Set<string>();
  for (const p of toStringArray(user.permissions)) perms.add(p);
  const metadata = user.metadata ?? undefined;
  if (metadata) {
    for (const p of toStringArray(metadata.permissions)) perms.add(p);
  }
  return [...perms];
};

const hasRequiredRole = (
  userRoles: string[],
  required: string | string[]
): boolean => {
  const requiredRoles = toStringArray(required);
  if (requiredRoles.length === 0) return true;
  return requiredRoles.some((r) => userRoles.includes(r));
};

export interface AdminAuditEntry {
  timestamp: number;
  userId: string;
  userEmail: string;
  operation: string;
  resource?: string;
  resourceId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  beforeValue?: Record<string, unknown>;
  afterValue?: Record<string, unknown>;
}

const MAX_AUDIT_ENTRIES = 1000;

let auditAdapter: ObservabilityLogAdapter<AdminAuditEntry> =
  createKVLogAdapter<AdminAuditEntry>({
    maxEntries: MAX_AUDIT_ENTRIES,
    order: "newest-first",
    keyPrefix: "covara:obs:audit",
  });

let auditSink: ((entry: AdminAuditEntry) => void | Promise<void>) | null = null;

export const setAdminAuditSink = (
  sink: ((entry: AdminAuditEntry) => void | Promise<void>) | null
): void => {
  auditSink = sink;
};

// Replace the audit-log backend (in-memory default, KV-backed, or bring-your-own
// durable store). The write-only `auditSink` still fires alongside it.
export const setAdminAuditAdapter = (
  adapter: ObservabilityLogAdapter<AdminAuditEntry>
): void => {
  auditAdapter = adapter;
};

export const logAdminAction = (entry: Omit<AdminAuditEntry, "timestamp">): void => {
  const fullEntry: AdminAuditEntry = { ...entry, timestamp: Date.now() };
  auditAdapter.append(fullEntry);
  if (auditSink) {
    try {
      const result = auditSink(fullEntry);
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    } catch {
      // Never let audit-sink failures break the action being audited.
    }
  }
};

// Synchronous read of the local mirror (page-load ergonomics). In KV mode this
// reflects only entries written by this process; use getAdminAuditLogAsync for
// the authoritative cross-instance view.
export const getAdminAuditLog = (
  limit: number = 100,
  offset: number = 0
): AdminAuditEntry[] => {
  return auditAdapter.querySync({ limit, offset });
};

export const getAdminAuditLogAsync = (
  limit: number = 100,
  offset: number = 0
): Promise<AdminAuditEntry[]> => {
  return auditAdapter.query({ limit, offset });
};

export const clearAdminAuditLog = (): void => {
  void auditAdapter.clear();
};

export const detectEnvironment = (): EnvironmentMode => {
  const env = readEnv("NODE_ENV")?.toLowerCase();
  if (env === "production") return "production";
  if (env === "staging") return "staging";
  return "development";
};

// Admin auth rate limiting. Uses the global KV store when configured (so limits
// are enforced across instances) and falls back to a per-process Map otherwise.
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

const checkAdminRateLimit = async (
  clientIP: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> => {
  if (hasGlobalKV()) {
    try {
      const kv = getGlobalKV();
      const kvKey = `covara:admin:ratelimit:${clientIP}`;
      const count = await kv.incr(kvKey);
      if (count === 1) await kv.expire(kvKey, Math.ceil(windowMs / 1000));
      return count > maxRequests;
    } catch {
      // fall through to local store on KV failure
    }
  }
  const now = Date.now();
  const entry = rateLimitStore.get(clientIP);
  if (entry && entry.resetAt > now) {
    if (entry.count >= maxRequests) return true;
    entry.count++;
    return false;
  }
  rateLimitStore.set(clientIP, { count: 1, resetAt: now + windowMs });
  return false;
};

export const createAdminAuthMiddleware = (
  config: AdminSecurityConfig = {}
): MiddlewareHandler => {
  const mode = config.mode ?? detectEnvironment();

  return async (c, next) => {
    const clientIP = getClientIP(c);

    if (config.allowedIPs && config.allowedIPs.length > 0 && mode === "production") {
      if (!config.allowedIPs.includes(clientIP)) {
        return c.json(
          {
            type: "/__covara/problems/forbidden",
            title: "IP not allowed",
            status: 403,
            detail: "Your IP address is not in the allowed list",
          },
          403
        );
      }
    }

    if (config.rateLimit) {
      const exceeded = await checkAdminRateLimit(
        clientIP,
        config.rateLimit.maxRequests,
        config.rateLimit.windowMs
      );
      if (exceeded) {
        return c.json(
          {
            type: "/__covara/problems/rate-limit-exceeded",
            title: "Rate limit exceeded",
            status: 429,
            detail: "Too many admin API requests",
          },
          429
        );
      }
    }

    if (config.auth?.disabled) {
      if (mode !== "development") {
        console.warn(
          "[Covara Admin] Auth is disabled in non-development mode. This is a security risk."
        );
      }
      c.set("adminUser", {
        id: "admin",
        email: "admin@localhost",
      });
      return next();
    }

    let adminUser: AdminUser | null = null;

    if (config.auth?.apiKey) {
      const authHeader = c.req.header("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        if (token === config.auth.apiKey) {
          adminUser = { id: "api-key", email: "api-key@admin" };
        }
      }

      const apiKeyHeader = c.req.header("x-admin-api-key");
      if (apiKeyHeader === config.auth.apiKey) {
        adminUser = { id: "api-key", email: "api-key@admin" };
      }
    }

    const sessionAuthConfigured =
      config.auth?.useSessionAuth === true ||
      config.requireRole !== undefined ||
      config.authorize !== undefined ||
      config.can !== undefined;

    if (!adminUser && sessionAuthConfigured) {
      const user = getUser(c);
      if (user) {
        adminUser = {
          id: user.id,
          email: user.email ?? "unknown",
          name: user.name ?? undefined,
          roles: extractUserRoles(user),
          permissions: extractUserPermissions(user),
        };
      }
    }

    if (!adminUser && config.auth?.authenticate) {
      try {
        adminUser = await config.auth.authenticate(c);
      } catch {
        adminUser = null;
      }
    }

    if (!adminUser) {
      const anyAuthConfigured =
        config.auth?.apiKey !== undefined ||
        config.auth?.authenticate !== undefined ||
        sessionAuthConfigured;

      if (mode === "development" && !anyAuthConfigured) {
        c.set("adminUser", {
          id: "dev-admin",
          email: "dev@localhost",
        });
        return next();
      }

      return c.json(
        {
          type: "/__covara/problems/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Admin authentication required",
        },
        401
      );
    }

    const requiredRole = config.requireRole ?? config.authorization?.requiredRole;
    if (requiredRole !== undefined) {
      if (!hasRequiredRole(adminUser.roles ?? [], requiredRole)) {
        const requiredLabel = toStringArray(requiredRole).join(", ");
        return c.json(
          {
            type: "/__covara/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: `Required role: ${requiredLabel}`,
          },
          403
        );
      }
    }

    if (config.authorization?.requiredPermission && adminUser.permissions) {
      if (!adminUser.permissions.includes(config.authorization.requiredPermission)) {
        return c.json(
          {
            type: "/__covara/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: `Required permission: ${config.authorization.requiredPermission}`,
          },
          403
        );
      }
    }

    if (config.authorization?.authorize) {
      const authorized = await config.authorization.authorize(adminUser);
      if (!authorized) {
        return c.json(
          {
            type: "/__covara/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Authorization check failed",
          },
          403
        );
      }
    }

    if (config.authorize) {
      const authorized = await config.authorize(adminUser, c);
      if (!authorized) {
        return c.json(
          {
            type: "/__covara/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Authorization check failed",
          },
          403
        );
      }
    }

    c.set("adminUser", adminUser);
    return next();
  };
};

export const createAdminBypassPredicate = (
  config: AdminSecurityConfig = {}
): ((user: UserContext | null, c: Context) => Promise<boolean>) => {
  const mode = config.mode ?? detectEnvironment();
  const requiredRole = config.requireRole ?? config.authorization?.requiredRole;

  const anyAuthConfigured =
    config.auth?.apiKey !== undefined ||
    config.auth?.authenticate !== undefined ||
    config.auth?.useSessionAuth === true ||
    config.requireRole !== undefined ||
    config.authorize !== undefined ||
    config.can !== undefined ||
    config.authorization !== undefined;

  const hasIdentityRule =
    requiredRole !== undefined ||
    config.authorization?.requiredPermission !== undefined ||
    config.authorization?.authorize !== undefined ||
    config.authorize !== undefined;

  return async (user, c) => {
    if (config.auth?.disabled) {
      return mode === "development";
    }

    if (config.auth?.apiKey) {
      const authHeader = c.req.header("authorization");
      const bearer = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      if (bearer === config.auth.apiKey) return true;
      if (c.req.header("x-admin-api-key") === config.auth.apiKey) return true;
    }

    if (mode === "development" && !anyAuthConfigured) {
      return true;
    }

    if (!user) return false;

    const adminUser: AdminUser = {
      id: user.id,
      email: user.email ?? "unknown",
      name: user.name ?? undefined,
      roles: extractUserRoles(user),
      permissions: extractUserPermissions(user),
    };

    if (
      requiredRole !== undefined &&
      !hasRequiredRole(adminUser.roles ?? [], requiredRole)
    ) {
      return false;
    }

    if (
      config.authorization?.requiredPermission &&
      !(adminUser.permissions ?? []).includes(
        config.authorization.requiredPermission
      )
    ) {
      return false;
    }

    if (
      config.authorization?.authorize &&
      !(await config.authorization.authorize(adminUser))
    ) {
      return false;
    }

    if (config.authorize && !(await config.authorize(adminUser, c))) {
      return false;
    }

    return hasIdentityRule;
  };
};

export const getAdminUser = (c: Context): AdminUser | null => {
  return c.get("adminUser") ?? null;
};

export const requireAdminUser = (c: Context): AdminUser => {
  const user = getAdminUser(c);
  if (!user) {
    throw new UnauthorizedError("Admin user not found in request");
  }
  return user;
};
