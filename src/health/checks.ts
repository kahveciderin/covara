import { KVAdapter } from "@/kv/types";

export interface HealthCheckResult {
  healthy: boolean;
  name: string;
  message?: string;
  latencyMs?: number;
}

export interface HealthChecks {
  kv?: KVAdapter;
  changelog?: {
    getCurrentSequence: () => Promise<number>;
  };
  tasks?: {
    getQueueDepth: () => Promise<number>;
  };
  dlq?: {
    count: () => Promise<number>;
  };
  custom?: () => Promise<HealthCheckResult>;
}

export interface HealthThresholds {
  eventLoopLagMs?: number;
  memoryPercent?: number;
  dlqMaxCount?: number;
}

const DEFAULT_THRESHOLDS: Required<HealthThresholds> = {
  eventLoopLagMs: 100,
  memoryPercent: 90,
  dlqMaxCount: 1000,
};

export const checkEventLoop = async (
  threshold: number
): Promise<HealthCheckResult> => {
  const schedule: (fn: () => void) => void =
    typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);
  const start = Date.now();
  return new Promise((resolve) => {
    schedule(() => {
      const lag = Date.now() - start;
      resolve({
        healthy: lag < threshold,
        name: "event_loop",
        message: lag >= threshold ? `Event loop lag: ${lag}ms` : undefined,
        latencyMs: lag,
      });
    });
  });
};

export const checkMemory = async (
  threshold: number
): Promise<HealthCheckResult> => {
  const proc = (globalThis as {
    process?: { memoryUsage?: () => { heapUsed: number; heapTotal: number } };
  }).process;

  if (typeof proc?.memoryUsage !== "function") {
    return {
      healthy: true,
      name: "memory",
      message: "Skipped: memory usage not available in this runtime",
      latencyMs: 0,
    };
  }

  const usage = proc.memoryUsage();
  const heapPercent = (usage.heapUsed / usage.heapTotal) * 100;

  return {
    healthy: heapPercent < threshold,
    name: "memory",
    message:
      heapPercent >= threshold
        ? `Memory usage: ${heapPercent.toFixed(1)}%`
        : undefined,
    latencyMs: 0,
  };
};

export const checkKV = async (kv: KVAdapter): Promise<HealthCheckResult> => {
  const start = Date.now();
  try {
    if (!kv.isConnected()) {
      return {
        healthy: false,
        name: "kv",
        message: "KV store not connected",
        latencyMs: Date.now() - start,
      };
    }

    const testKey = "__covara_health_check";
    await kv.set(testKey, "1", { ex: 10 });
    const value = await kv.get(testKey);

    if (value !== "1") {
      return {
        healthy: false,
        name: "kv",
        message: "KV read/write verification failed",
        latencyMs: Date.now() - start,
      };
    }

    return {
      healthy: true,
      name: "kv",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      name: "kv",
      message: error instanceof Error ? error.message : "Unknown error",
      latencyMs: Date.now() - start,
    };
  }
};

export const checkChangelog = async (changelog: {
  getCurrentSequence: () => Promise<number>;
}): Promise<HealthCheckResult> => {
  const start = Date.now();
  try {
    const seq = await changelog.getCurrentSequence();

    return {
      healthy: seq >= 0,
      name: "changelog",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      name: "changelog",
      message: error instanceof Error ? error.message : "Unknown error",
      latencyMs: Date.now() - start,
    };
  }
};

export const checkTasks = async (tasks: {
  getQueueDepth: () => Promise<number>;
}): Promise<HealthCheckResult> => {
  const start = Date.now();
  try {
    const depth = await tasks.getQueueDepth();

    return {
      healthy: true,
      name: "tasks",
      message: `Queue depth: ${depth}`,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      name: "tasks",
      message: error instanceof Error ? error.message : "Unknown error",
      latencyMs: Date.now() - start,
    };
  }
};

export const checkDLQ = async (
  dlq: { count: () => Promise<number> },
  threshold: number
): Promise<HealthCheckResult> => {
  const start = Date.now();
  try {
    const count = await dlq.count();

    return {
      healthy: count < threshold,
      name: "dlq",
      message: count >= threshold ? `DLQ count: ${count}` : undefined,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      name: "dlq",
      message: error instanceof Error ? error.message : "Unknown error",
      latencyMs: Date.now() - start,
    };
  }
};

export const runLivenessChecks = async (
  thresholds: HealthThresholds = {}
): Promise<HealthCheckResult[]> => {
  const merged = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const results = await Promise.all([
    checkEventLoop(merged.eventLoopLagMs),
    checkMemory(merged.memoryPercent),
  ]);

  return results;
};

export const runReadinessChecks = async (
  checks: HealthChecks,
  thresholds: HealthThresholds = {}
): Promise<HealthCheckResult[]> => {
  const merged = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const results: HealthCheckResult[] = [];

  if (checks.kv) {
    results.push(await checkKV(checks.kv));
  }

  if (checks.changelog) {
    results.push(await checkChangelog(checks.changelog));
  }

  if (checks.tasks) {
    results.push(await checkTasks(checks.tasks));
  }

  if (checks.dlq) {
    results.push(await checkDLQ(checks.dlq, merged.dlqMaxCount));
  }

  if (checks.custom) {
    results.push(await checks.custom());
  }

  return results;
};
