import { Hono } from "hono";
import {
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
  runLivenessChecks,
  runReadinessChecks,
} from "./checks";
import { isShuttingDown } from "@/server/lifecycle";

export interface HealthConfig {
  enabled?: boolean;
  basePath?: string;
  version?: string;
  checks?: {
    kv?: HealthChecks["kv"];
    changelog?: HealthChecks["changelog"];
    tasks?: HealthChecks["tasks"];
    dlq?: HealthChecks["dlq"];
    custom?: HealthChecks["custom"];
  };
  thresholds?: HealthThresholds;
}

export interface HealthResponse {
  status: "healthy" | "unhealthy";
  version?: string;
  timestamp: string;
  uptime: number;
  checks?: HealthCheckResult[];
}

const startTime = Date.now();

const buildResponse = (
  checks: HealthCheckResult[],
  version?: string
): HealthResponse => {
  const allHealthy = checks.every((c) => c.healthy);

  return {
    status: allHealthy ? "healthy" : "unhealthy",
    version,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime,
    checks: checks.length > 0 ? checks : undefined,
  };
};

export const createHealthEndpoints = (config: HealthConfig = {}): Hono => {
  const router = new Hono();
  const basePath = config.basePath || "";

  if (config.enabled === false) {
    return router;
  }

  const buildChecksConfig = (): HealthChecks => ({
    kv: config.checks?.kv,
    changelog: config.checks?.changelog,
    tasks: config.checks?.tasks,
    dlq: config.checks?.dlq,
    custom: config.checks?.custom,
  });

  router.get(`${basePath}/healthz`, async (c) => {
    try {
      const checks = await runLivenessChecks(config.thresholds);
      const response = buildResponse(checks, config.version);

      return c.json(response, response.status === "healthy" ? 200 : 503);
    } catch (error) {
      return c.json(
        {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          uptime: Date.now() - startTime,
          checks: [
            {
              healthy: false,
              name: "liveness",
              message: error instanceof Error ? error.message : "Unknown error",
            },
          ],
        },
        503
      );
    }
  });

  router.get(`${basePath}/readyz`, async (c) => {
    if (isShuttingDown()) {
      return c.json(
        {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          uptime: Date.now() - startTime,
          checks: [{ healthy: false, name: "readiness", message: "Server is shutting down" }],
        },
        503
      );
    }
    try {
      const checks = await runReadinessChecks(buildChecksConfig(), config.thresholds);
      const response = buildResponse(checks, config.version);

      return c.json(response, response.status === "healthy" ? 200 : 503);
    } catch (error) {
      return c.json(
        {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          uptime: Date.now() - startTime,
          checks: [
            {
              healthy: false,
              name: "readiness",
              message: error instanceof Error ? error.message : "Unknown error",
            },
          ],
        },
        503
      );
    }
  });

  router.on("HEAD", `${basePath}/healthz`, async (c) => {
    try {
      const checks = await runLivenessChecks(config.thresholds);
      const allHealthy = checks.every((check) => check.healthy);
      return c.body(null, allHealthy ? 200 : 503);
    } catch {
      return c.body(null, 503);
    }
  });

  router.on("HEAD", `${basePath}/readyz`, async (c) => {
    if (isShuttingDown()) {
      return c.body(null, 503);
    }
    try {
      const checks = await runReadinessChecks(buildChecksConfig(), config.thresholds);
      const allHealthy = checks.every((check) => check.healthy);
      return c.body(null, allHealthy ? 200 : 503);
    } catch {
      return c.body(null, 503);
    }
  });

  return router;
};

export type {
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
} from "./checks";
export {
  runLivenessChecks,
  runReadinessChecks,
  checkEventLoop,
  checkMemory,
  checkKV,
  checkChangelog,
  checkTasks,
  checkDLQ,
} from "./checks";
