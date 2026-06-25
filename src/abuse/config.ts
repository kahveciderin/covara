/**
 * Abuse-protection configuration: a token-bucket `budget` (cost-weighted rate
 * limiting, hard-rejects with 429) and a `pow` proof-of-work gate, which are
 * fully independent and may be enabled together. Costs and PoW opt-ins live on
 * the individual endpoints; this module holds only the shared/global settings.
 */

import type { Context } from "hono";
import type { KVAdapter } from "@/kv";
import type { UserContext } from "@/resource/types";
import type { PowAlgorithm } from "@/pow/core";
import type { CaptchaProvider } from "./captcha";

export interface BudgetClassConfig {
  capacity: number;
  refillPerMinute: number;
}

export interface BudgetConfig {
  enabled?: boolean;
  /**
   * Map a request to an identity class name. Defaults to "authenticated" for a
   * logged-in user and "anonymous" otherwise.
   */
  classify?: (c: Context) => string;
  /** Token bucket parameters per identity class. */
  classes: Record<string, BudgetClassConfig>;
  /**
   * Derive the bucket key for a request within its class. Defaults to the user
   * id (authenticated) or client IP (anonymous), namespaced by class.
   */
  keyGenerator?: (c: Context, className: string) => string;
  /** Optional explicit KV store; defaults to the global KV, else in-memory. */
  store?: KVAdapter;
}

export interface PowDifficultyContext {
  c: Context;
  user: UserContext | null;
  ip: string;
  /** Operation key, e.g. "read", "create", "rpc:generate", "auth.signup". */
  operation: string;
  resource?: string;
  /** The statically configured difficulty before any hook adjustment. */
  baseDifficulty: number;
  /**
   * Why the challenge is being considered:
   * - "endpoint": the endpoint always requires PoW (its `pow` opt-in).
   * - "budget": the caller is over budget, so PoW is the overflow valve.
   */
  reason: "endpoint" | "budget";
  /** Budget cost of the operation (present when reason === "budget"). */
  cost?: number;
  /** Tokens available before the charge (present when reason === "budget"). */
  available?: number;
  /** How far over budget the request is, `cost - available` (budget reason). */
  deficit?: number;
}

export interface PowConfig {
  enabled?: boolean;
  secret?: string;
  /** Default leading-zero-bit difficulty when an endpoint enables PoW. */
  difficulty?: number;
  /**
   * Programmatic difficulty control (IP/user trust). Return 0 to skip the
   * challenge for trusted callers. Overrides the static difficulty.
   */
  getDifficulty?: (ctx: PowDifficultyContext) => number | Promise<number>;
  challengeTtlMs?: number;
  algorithm?: PowAlgorithm;
  /** Optional explicit KV store for the replay cache; defaults to global KV. */
  store?: KVAdapter;
  /** Bind challenges to a hash of the request body (default true). */
  bindBody?: boolean;
}

/** Which mechanism a budget-exhausted (overflow) request is challenged with. */
export type OverflowMechanism = "pow" | "captcha";

export interface CaptchaContext {
  c: Context;
  user: UserContext | null;
  ip: string;
  operation: string;
  resource?: string;
  reason: "endpoint" | "budget";
}

export interface CaptchaConfig {
  /** BETA. The verification provider (turnstile/hcaptcha/recaptcha/custom). */
  provider: CaptchaProvider;
  enabled?: boolean;
  /** Request header carrying the solved token (default "Covara-Captcha-Token"). */
  tokenHeader?: string;
}

export interface AbuseProtectionInput {
  budget?: BudgetConfig;
  pow?: PowConfig;
  /** CAPTCHA challenge support (BETA). */
  captcha?: CaptchaConfig;
  /** Default mechanism for budget-overflow challenges (default "pow"). */
  overflow?: OverflowMechanism;
}

export interface AbuseProtectionConfig {
  budget: BudgetConfig | null;
  pow: PowConfig | null;
  captcha: CaptchaConfig | null;
  overflow: OverflowMechanism;
}

export const DEFAULT_POW_DIFFICULTY = 20;
export const DEFAULT_POW_TTL_MS = 120_000;

/**
 * Per-endpoint PoW opt-in (procedures, auth routes). `true` uses the
 * global/default difficulty; an object overrides difficulty or supplies an
 * endpoint-specific trust hook.
 */
export type EndpointPowConfig =
  | boolean
  | {
      difficulty?: number;
      getDifficulty?: (ctx: PowDifficultyContext) => number | Promise<number>;
    };

/** Operations that can carry an inline budget cost or PoW gate on a resource. */
export type AbuseOperation =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "subscribe"
  | "count"
  | "aggregate"
  | "search";

/** Inline per-operation budget costs declared on a resource. */
export type ResourceCostConfig = Partial<Record<AbuseOperation, number>>;

/**
 * Resource-level PoW opt-in. `true` gates the mutating operations
 * (create/update/delete) at the default difficulty. An object can override the
 * difficulty/trust hook and restrict (or widen) the gated `operations`.
 */
export type ResourcePowConfig =
  | boolean
  | {
      difficulty?: number;
      getDifficulty?: (ctx: PowDifficultyContext) => number | Promise<number>;
      operations?: AbuseOperation[];
    };

/**
 * Per-endpoint CAPTCHA opt-in (procedures, auth routes). `true` always requires
 * a CAPTCHA; an object can supply a reCAPTCHA v3 `action` or a `required` hook.
 */
export type EndpointCaptchaConfig =
  | boolean
  | {
      action?: string;
      required?: (ctx: CaptchaContext) => boolean | Promise<boolean>;
    };

/** Resource-level CAPTCHA opt-in; `operations` restricts which it gates. */
export type ResourceCaptchaConfig =
  | boolean
  | {
      action?: string;
      required?: (ctx: CaptchaContext) => boolean | Promise<boolean>;
      operations?: AbuseOperation[];
    };

const normalize = (
  input: AbuseProtectionInput | AbuseProtectionConfig
): AbuseProtectionConfig => ({
  budget: input.budget ?? null,
  pow: input.pow ?? null,
  captcha: input.captcha ?? null,
  overflow: input.overflow ?? "pow",
});

let globalConfig: AbuseProtectionConfig | null = null;

export const abuseProtection = (
  input: AbuseProtectionInput
): AbuseProtectionConfig => {
  const config = normalize(input);
  setGlobalAbuseProtection(config);
  return config;
};

export const setGlobalAbuseProtection = (
  config: AbuseProtectionConfig | AbuseProtectionInput
): void => {
  globalConfig = normalize(config);
};

export const getGlobalAbuseProtection = (): AbuseProtectionConfig | null =>
  globalConfig;

export const hasGlobalAbuseProtection = (): boolean => globalConfig !== null;

export const clearGlobalAbuseProtection = (): void => {
  globalConfig = null;
};

export const isBudgetEnabled = (config: AbuseProtectionConfig | null): boolean =>
  !!config?.budget && config.budget.enabled !== false &&
  Object.keys(config.budget.classes ?? {}).length > 0;

export const isPowEnabled = (config: AbuseProtectionConfig | null): boolean =>
  !config?.pow || config.pow.enabled !== false;

export const isCaptchaEnabled = (config: AbuseProtectionConfig | null): boolean =>
  !!config?.captcha && config.captcha.enabled !== false;
