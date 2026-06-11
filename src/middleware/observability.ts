import type { Context, MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { getLogger } from "@/server/logger";

declare module "hono" {
  interface ContextVariableMap {
    requestStartTime?: number;
    resource?: string;
    operation?: string;
    traceId?: string;
  }
}

export interface RequestMetrics {
  requestId: string;
  traceId?: string;
  method: string;
  path: string;
  resource?: string;
  operation?: string;
  status: number;
  duration: number;
  timestamp: number;
  query?: Record<string, unknown>;
  error?: string;
}

export interface SpanInfo {
  requestId: string;
  traceId: string;
  method: string;
  path: string;
  resource?: string;
  operation?: string;
}

export interface SubscriptionMetrics {
  subscriptionId: string;
  resource: string;
  event: "connected" | "disconnected" | "event_sent" | "backpressure" | "invalidate";
  userId?: string;
  duration?: number;
  eventCount?: number;
}

export interface ErrorMetrics {
  requestId?: string;
  method: string;
  path: string;
  status: number;
  errorCode: string;
  errorMessage: string;
  timestamp: number;
}

export interface MetricsConfig {
  onRequest?: (metrics: RequestMetrics) => void;
  onSubscription?: (metrics: SubscriptionMetrics) => void;
  onError?: (metrics: ErrorMetrics) => void;
}

export interface ObservabilityConfig {
  enableRequestId?: boolean;
  enableTiming?: boolean;
  enableSlowQueryLog?: boolean;
  slowQueryThresholdMs?: number;
  requestIdHeader?: string;
  traceIdHeader?: string;
  metrics?: MetricsConfig;
  onMetrics?: (metrics: RequestMetrics) => void;
  onSpan?: (span: SpanInfo) => void;
  logger?: Logger;
}

export interface Logger {
  info: (msg: string | object) => void;
  warn: (msg: string | object) => void;
  error: (msg: string | object) => void;
}

const toStructured = (
  level: "info" | "warn" | "error",
  msg: string | object
): void => {
  const log = getLogger();
  if (typeof msg === "string") {
    log[level](msg);
    return;
  }
  const { message, level: _level, ...fields } = msg as Record<string, unknown>;
  log[level](typeof message === "string" ? message : "log", fields);
};

const defaultLogger: Logger = {
  info: (msg) => toStructured("info", msg),
  warn: (msg) => toStructured("warn", msg),
  error: (msg) => toStructured("error", msg),
};

const DEFAULT_CONFIG: Required<
  Omit<ObservabilityConfig, "onMetrics" | "onSpan">
> & {
  onMetrics?: (metrics: RequestMetrics) => void;
  onSpan?: (span: SpanInfo) => void;
} = {
  enableRequestId: true,
  enableTiming: true,
  enableSlowQueryLog: true,
  slowQueryThresholdMs: 1000,
  requestIdHeader: "x-request-id",
  traceIdHeader: "traceparent",
  metrics: {},
  onMetrics: undefined,
  onSpan: undefined,
  logger: defaultLogger,
};

const parseTraceId = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const parts = header.split("-");
  if (parts.length >= 3 && parts[1] && parts[1].length === 32) {
    return parts[1];
  }
  return header;
};

export const observabilityMiddleware = (config: ObservabilityConfig = {}): MiddlewareHandler => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const {
    enableRequestId,
    enableTiming,
    enableSlowQueryLog,
    slowQueryThresholdMs,
    requestIdHeader,
    traceIdHeader,
    metrics,
    onMetrics,
    onSpan,
    logger,
  } = mergedConfig;

  return async (c, next) => {
    let requestId: string | undefined;
    if (enableRequestId) {
      requestId = c.req.header(requestIdHeader) || randomUUID();
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
    }

    const traceId =
      parseTraceId(c.req.header(traceIdHeader)) ?? c.get("requestId");
    if (traceId) {
      c.set("traceId", traceId);
    }

    if (onSpan && traceId) {
      onSpan({
        requestId: c.get("requestId") ?? traceId,
        traceId,
        method: c.req.method,
        path: c.req.path,
        resource: c.get("resource"),
        operation: c.get("operation"),
      });
    }

    let startTime: number | undefined;
    if (enableTiming) {
      startTime = performance.now();
      c.set("requestStartTime", startTime);
    }

    await next();

    if (!enableTiming || startTime === undefined) return;

    const duration = performance.now() - startTime;

    const requestMetrics: RequestMetrics = {
      requestId: c.get("requestId") ?? "unknown",
      traceId: c.get("traceId"),
      method: c.req.method,
      path: c.req.path,
      resource: c.get("resource"),
      operation: c.get("operation"),
      status: c.res.status,
      duration,
      timestamp: Date.now(),
    };

    if (enableSlowQueryLog && duration > slowQueryThresholdMs) {
      logger.warn({
        level: "warn",
        message: "Slow request",
        durationMs: duration,
        ...requestMetrics,
      });
    }

    if (c.req.method !== "GET" || c.res.status >= 400) {
      logger.info({
        level: "info",
        message: "Request completed",
        durationMs: duration,
        ...requestMetrics,
      });
    }

    metrics.onRequest?.(requestMetrics);
    onMetrics?.(requestMetrics);
  };
};

export const requestIdMiddleware = (headerName: string = "x-request-id"): MiddlewareHandler => {
  return async (c, next) => {
    const requestId = c.req.header(headerName) || randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    return next();
  };
};

export const timingMiddleware = (config?: { slowQueryThresholdMs?: number }): MiddlewareHandler => {
  const slowQueryThresholdMs = config?.slowQueryThresholdMs ?? 1000;

  return async (c, next) => {
    const startTime = performance.now();
    c.set("requestStartTime", startTime);

    await next();

    const duration = performance.now() - startTime;

    c.res.headers.set("X-Response-Time", `${duration.toFixed(2)}ms`);

    if (duration > slowQueryThresholdMs) {
      getLogger().warn("Slow request", {
        method: c.req.method,
        path: c.req.path,
        durationMs: duration,
        status: c.res.status,
        requestId: c.get("requestId"),
      });
    }
  };
};

export const resourceContextMiddleware = (
  resource: string,
  operation?: string
): MiddlewareHandler => {
  return async (c, next) => {
    c.set("resource", resource);
    if (operation) {
      c.set("operation", operation);
    }
    return next();
  };
};

export const getRequestId = (c: Context): string | undefined => {
  return c.get("requestId");
};

export const getRequestDuration = (c: Context): number => {
  const startTime = c.get("requestStartTime");
  if (startTime === undefined) return 0;

  return performance.now() - startTime;
};

export interface MetricsCollectorConfig {
  maxMetrics?: number;
}

export const createMetricsCollector = (config: MetricsCollectorConfig = {}) => {
  const requestMetrics: RequestMetrics[] = [];
  const subscriptionMetrics: SubscriptionMetrics[] = [];
  const errorMetrics: ErrorMetrics[] = [];

  let maxEntries = config.maxMetrics ?? 1000;

  const pruneOldEntries = <T>(arr: T[]): void => {
    if (arr.length > maxEntries) {
      arr.splice(0, arr.length - maxEntries);
    }
  };

  return {
    setMaxEntries: (max: number) => {
      maxEntries = max;
    },

    record: (metrics: RequestMetrics) => {
      requestMetrics.push(metrics);
      pruneOldEntries(requestMetrics);
    },

    onRequest: (metrics: RequestMetrics) => {
      requestMetrics.push(metrics);
      pruneOldEntries(requestMetrics);
    },

    onSubscription: (metrics: SubscriptionMetrics) => {
      subscriptionMetrics.push(metrics);
      pruneOldEntries(subscriptionMetrics);
    },

    onError: (metrics: ErrorMetrics) => {
      errorMetrics.push(metrics);
      pruneOldEntries(errorMetrics);
    },

    getRecent: (count: number): RequestMetrics[] => {
      return requestMetrics.slice(-count);
    },

    getRequestMetrics: (filter?: Partial<RequestMetrics>): RequestMetrics[] => {
      if (!filter) return [...requestMetrics];

      return requestMetrics.filter((m) => {
        for (const [key, value] of Object.entries(filter)) {
          if (m[key as keyof RequestMetrics] !== value) return false;
        }
        return true;
      });
    },

    getByPath: (path: string): RequestMetrics[] => {
      return requestMetrics.filter((m) => m.path === path);
    },

    getSlow: (thresholdMs: number): RequestMetrics[] => {
      return requestMetrics.filter((m) => m.duration > thresholdMs);
    },

    getSubscriptionMetrics: (): SubscriptionMetrics[] => {
      return [...subscriptionMetrics];
    },

    getErrorMetrics: (): ErrorMetrics[] => {
      return [...errorMetrics];
    },

    getStats: () => {
      const total = requestMetrics.length;
      const avgDuration =
        total > 0
          ? requestMetrics.reduce((sum, m) => sum + m.duration, 0) / total
          : 0;
      const errorCount = requestMetrics.filter((m) => m.status >= 400).length;
      const errorRate = total > 0 ? errorCount / total : 0;

      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      const fiveMinutesAgo = now - 300000;

      const recentRequests = requestMetrics.filter(
        (m) => m.timestamp > oneMinuteAgo
      );
      const last5MinRequests = requestMetrics.filter(
        (m) => m.timestamp > fiveMinutesAgo
      );

      return {
        total,
        avgDuration,
        errorRate,
        requestsPerMinute: recentRequests.length,
        requestsLast5Minutes: last5MinRequests.length,
        activeSubscriptions: subscriptionMetrics.filter(
          (m) => m.event === "connected"
        ).length,
      };
    },

    clear: () => {
      requestMetrics.length = 0;
      subscriptionMetrics.length = 0;
      errorMetrics.length = 0;
    },
  };
};

export type MetricsCollector = ReturnType<typeof createMetricsCollector>;
