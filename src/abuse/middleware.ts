/**
 * Resource-level abuse-protection middleware. Maps the request to an operation,
 * looks up that operation's inline budget cost and PoW gate, and enforces
 * **PoW first, then budget** (so a request challenged for PoW is never charged).
 */

import type { MiddlewareHandler } from "hono";
import {
  type AbuseOperation,
  type EndpointCaptchaConfig,
  type EndpointPowConfig,
  type OverflowMechanism,
  type ResourceCaptchaConfig,
  type ResourceCostConfig,
  type ResourcePowConfig,
} from "./config";
import { enforceAbuse } from "./enforce";

export interface AbuseMiddlewareConfig {
  cost?: ResourceCostConfig;
  pow?: ResourcePowConfig;
  captcha?: ResourceCaptchaConfig;
  overflow?: OverflowMechanism;
  procedures?: Record<
    string,
    { cost?: number; pow?: EndpointPowConfig; captcha?: EndpointCaptchaConfig; overflow?: OverflowMechanism }
  >;
}

interface Classified {
  operation: AbuseOperation | "rpc";
  cost: number;
  endpointPow: EndpointPowConfig;
  endpointCaptcha: EndpointCaptchaConfig;
  overflow?: OverflowMechanism;
  label: string;
}

const MUTATION_OPS: AbuseOperation[] = ["create", "update", "delete"];

const methodOperation = (method: string): AbuseOperation => {
  switch (method) {
    case "POST":
      return "create";
    case "PATCH":
    case "PUT":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "read";
  }
};

const classifyOperation = (
  method: string,
  path: string
): { operation: AbuseOperation | "rpc"; procedureName?: string } => {
  const rpcIndex = path.lastIndexOf("/rpc/");
  if (rpcIndex !== -1) {
    return { operation: "rpc", procedureName: path.slice(rpcIndex + 5) };
  }
  if (path.endsWith("/aggregate/subscribe") || path.endsWith("/subscribe")) {
    return { operation: "subscribe" };
  }
  if (path.endsWith("/aggregate")) return { operation: "aggregate" };
  if (path.endsWith("/count")) return { operation: "count" };
  if (path.endsWith("/search")) return { operation: "read" };
  if (path.endsWith("/batch") || path.endsWith("/batch/upsert")) {
    return { operation: method === "GET" ? "read" : methodOperation(method) };
  }
  return { operation: methodOperation(method) };
};

const resourcePowForOp = (
  pow: ResourcePowConfig | undefined,
  op: AbuseOperation
): EndpointPowConfig => {
  if (!pow) return false;
  if (pow === true) return MUTATION_OPS.includes(op);
  const ops = pow.operations ?? MUTATION_OPS;
  if (!ops.includes(op)) return false;
  return { difficulty: pow.difficulty, getDifficulty: pow.getDifficulty };
};

const resourceCaptchaForOp = (
  captcha: ResourceCaptchaConfig | undefined,
  op: AbuseOperation
): EndpointCaptchaConfig => {
  if (!captcha) return false;
  if (captcha === true) return MUTATION_OPS.includes(op);
  const ops = captcha.operations ?? MUTATION_OPS;
  if (!ops.includes(op)) return false;
  return { action: captcha.action, required: captcha.required };
};

const classify = (
  config: AbuseMiddlewareConfig,
  method: string,
  path: string
): Classified => {
  const { operation, procedureName } = classifyOperation(method, path);

  if (operation === "rpc") {
    const proc = procedureName ? config.procedures?.[procedureName] : undefined;
    return {
      operation: "rpc",
      cost: proc?.cost ?? 0,
      endpointPow: proc?.pow ?? false,
      endpointCaptcha: proc?.captcha ?? false,
      overflow: proc?.overflow ?? config.overflow,
      label: `rpc:${procedureName ?? "unknown"}`,
    };
  }

  return {
    operation,
    cost: config.cost?.[operation] ?? 0,
    endpointPow: resourcePowForOp(config.pow, operation),
    endpointCaptcha: resourceCaptchaForOp(config.captcha, operation),
    overflow: config.overflow,
    label: operation,
  };
};

/**
 * True when a resource declares any abuse-protection surface (inline costs or a
 * PoW gate). Used by the hook to decide whether to mount the middleware.
 */
export const resourceHasAbuseConfig = (config: AbuseMiddlewareConfig): boolean => {
  if (config.cost && Object.keys(config.cost).length > 0) return true;
  if (config.pow || config.captcha) return true;
  if (config.procedures) {
    for (const proc of Object.values(config.procedures)) {
      if (proc.cost || proc.pow || proc.captcha) return true;
    }
  }
  return false;
};

export const createAbuseMiddleware = (
  resourceName: string,
  config: AbuseMiddlewareConfig
): MiddlewareHandler => {
  return async (c, next) => {
    const { cost, endpointPow, endpointCaptcha, overflow, label } = classify(
      config,
      c.req.method.toUpperCase(),
      c.req.path
    );

    if (cost > 0 || endpointPow || endpointCaptcha) {
      await enforceAbuse(c, {
        operation: label,
        resource: resourceName,
        cost,
        endpointPow,
        endpointCaptcha,
        overflow,
      });
    }

    return next();
  };
};
