/**
 * Unified abuse enforcement. A request's cost is charged against a token-bucket
 * budget; when the budget is exhausted, proof of work is the overflow valve —
 * the server issues a 428 challenge (difficulty scalable via a trust hook)
 * instead of a hard rejection, and solving it pays the overdraft (the bucket is
 * drained to zero). An endpoint can also *always* require PoW via its `pow`
 * opt-in, independent of budget. When PoW is disabled, budget exhaustion falls
 * back to a hard 429.
 */

import type { Context } from "hono";
import { getUser } from "@/server/context";
import { getClientIP } from "@/server/request";
import { CaptchaRequiredError, PowRequiredError, RateLimitError } from "@/resource/error";
import {
  computeFingerprint,
  consumeNonce,
  issueChallenge,
  resolvePowSecret,
  verifySolution,
} from "@/pow/server";
import { BudgetStore } from "./budget";
import {
  DEFAULT_POW_DIFFICULTY,
  DEFAULT_POW_TTL_MS,
  getGlobalAbuseProtection,
  isCaptchaEnabled,
  isPowEnabled,
  type BudgetConfig,
  type CaptchaContext,
  type EndpointCaptchaConfig,
  type EndpointPowConfig,
  type OverflowMechanism,
  type PowConfig,
  type PowDifficultyContext,
} from "./config";

const defaultBudgetKey = (c: Context, className: string): string => {
  const user = getUser(c);
  if (user) return `${className}:user:${user.id}`;
  return `${className}:ip:${getClientIP(c)}`;
};

const resolveBudgetTarget = (c: Context, budget: BudgetConfig) => {
  const className = budget.classify
    ? budget.classify(c)
    : getUser(c)
      ? "authenticated"
      : "anonymous";
  const classConfig = budget.classes[className];
  if (!classConfig) return null;
  const key = budget.keyGenerator
    ? budget.keyGenerator(c, className)
    : defaultBudgetKey(c, className);
  return { className, classConfig, key };
};

const HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface EnforceAbuseOptions {
  operation: string;
  resource?: string;
  /** Budget cost of this operation (0/undefined = not charged). */
  cost?: number;
  /** Endpoint always-PoW opt-in (independent of budget). */
  endpointPow?: EndpointPowConfig;
  /** Endpoint always-CAPTCHA opt-in (independent of budget). */
  endpointCaptcha?: EndpointCaptchaConfig;
  /** Override the budget-overflow mechanism for this endpoint. */
  overflow?: OverflowMechanism;
  /**
   * Defer the budget debit: don't charge on allow, instead return a `settle()`
   * the caller invokes when it decides the request counts (e.g. a failed
   * login). When false (default) the cost is debited before returning.
   */
  defer?: boolean;
}

export interface AbuseGateResult {
  /**
   * Debit the operation's cost (floored at zero). A no-op in immediate mode
   * (already charged); in deferred mode the caller invokes it to commit the
   * charge. Safe to call at most once.
   */
  settle(): Promise<void>;
}

const NOOP_GATE: AbuseGateResult = { settle: async () => {} };

const baseDifficulty = (
  endpointPow: EndpointPowConfig | undefined,
  pow: PowConfig | null
): number =>
  (typeof endpointPow === "object" ? endpointPow.difficulty : undefined) ??
  pow?.difficulty ??
  DEFAULT_POW_DIFFICULTY;

/**
 * Charge an operation against the budget, gating with proof of work as needed.
 * Throws `PowRequiredError` (428) when a challenge is required and unsolved, or
 * `RateLimitError` (429) when over budget and PoW is disabled.
 */
export const enforceAbuse = async (
  c: Context,
  options: EnforceAbuseOptions
): Promise<AbuseGateResult> => {
  const global = getGlobalAbuseProtection();
  const pow = global?.pow ?? null;
  const budget = global?.budget ?? null;
  const captcha = global?.captcha ?? null;
  const powEnabled = isPowEnabled(global);
  const captchaEnabled = isCaptchaEnabled(global);
  const overflow: OverflowMechanism = options.overflow ?? global?.overflow ?? "pow";
  const cost = options.cost ?? 0;

  // 1. Assess the budget (no deduction yet) so a challenged-but-unsolved
  //    request is never charged.
  let sufficient = true;
  let available = 0;
  let deficit = 0;
  let retryAfterMs = 0;
  let deduct: () => Promise<void> = async () => {};

  if (cost > 0 && budget && budget.enabled !== false) {
    const target = resolveBudgetTarget(c, budget);
    if (target) {
      const store = new BudgetStore(budget.store);
      const now = Date.now();
      const assessment = await store.assess(target.key, cost, target.classConfig, now);
      sufficient = assessment.sufficient;
      available = assessment.tokens;
      deficit = assessment.deficit;
      retryAfterMs = assessment.retryAfterMs;
      deduct = () => store.deduct(target.key, cost, target.classConfig, now).then(() => undefined);
    }
  }

  // 2. Decide whether a CAPTCHA gate applies (always-on endpoint gate, or the
  //    budget-overflow valve when overflow === "captcha"). CAPTCHA takes
  //    precedence over PoW when both would fire.
  let captchaAction: string | undefined;
  let captchaGate = false;
  if (captchaEnabled) {
    if (options.endpointCaptcha) {
      const ec = options.endpointCaptcha;
      captchaAction = typeof ec === "object" ? ec.action : undefined;
      const required =
        typeof ec === "object" && ec.required
          ? await ec.required(captchaContext(c, options))
          : true;
      if (required) captchaGate = true;
    }
    if (!sufficient && overflow === "captcha") captchaGate = true;
  }

  // 3. Resolve the required PoW difficulty (skipped when CAPTCHA wins): the max
  //    of an always-on endpoint gate and the budget-overflow gate.
  let difficulty = 0;
  let powOverflowUnavailable = false;
  if (!captchaGate) {
    if (powEnabled && options.endpointPow) {
      difficulty = Math.max(
        difficulty,
        await resolveDifficulty(c, options, pow, {
          reason: "endpoint",
          base: baseDifficulty(options.endpointPow, pow),
          hook:
            (typeof options.endpointPow === "object" ? options.endpointPow.getDifficulty : undefined) ??
            pow?.getDifficulty,
        })
      );
    }
    if (!sufficient) {
      // The overflow valve resolves to PoW either when configured, or as a
      // fallback when "captcha" was requested but CAPTCHA isn't available.
      if (powEnabled) {
        difficulty = Math.max(
          difficulty,
          await resolveDifficulty(c, options, pow, {
            reason: "budget",
            base: pow?.difficulty ?? DEFAULT_POW_DIFFICULTY,
            hook: pow?.getDifficulty,
            cost,
            available,
            deficit,
          })
        );
      } else {
        powOverflowUnavailable = true;
      }
    }
  }

  // 4. Over budget with no usable valve (no CAPTCHA gate and PoW disabled) ->
  //    hard 429.
  if (!sufficient && !captchaGate && powOverflowUnavailable) {
    throw new RateLimitError(
      Math.min(Math.max(1000, retryAfterMs), 86_400_000),
      "Budget exhausted, slow down"
    );
  }

  // 5. CAPTCHA gate (precedence): accept a valid token or issue a challenge.
  if (captchaGate && captcha) {
    const tokenHeader = captcha.tokenHeader ?? "Covara-Captcha-Token";
    const token = c.req.header(tokenHeader);
    const ok = token
      ? await captcha.provider.verify(token, { ip: getClientIP(c), action: captchaAction })
      : false;
    if (!ok) {
      throw new CaptchaRequiredError(captcha.provider.name, captcha.provider.siteKey, captchaAction);
    }
  } else if (difficulty > 0) {
    // 6. PoW gate: accept a valid, fresh solution or issue one.
    const secret = resolvePowSecret(pow?.secret);
    const algorithm = pow?.algorithm ?? "sha256";
    const ttlMs = pow?.challengeTtlMs ?? DEFAULT_POW_TTL_MS;
    const bindBody = pow?.bindBody !== false;

    const url = new URL(c.req.url);
    const method = c.req.method.toUpperCase();
    let bodyText = "";
    if (bindBody && HAS_BODY.has(method)) {
      bodyText = await c.req.raw
        .clone()
        .text()
        .catch(() => "");
    }
    const fingerprint = computeFingerprint(method, url.pathname + url.search, bodyText);

    const token = c.req.header("Covara-PoW-Challenge");
    const nonce = c.req.header("Covara-PoW-Nonce");
    const verdict = verifySolution({ secret, token, nonce, fingerprint });
    const solved =
      verdict.ok && verdict.payload
        ? await consumeNonce(verdict.payload.n, verdict.payload.exp, pow?.store)
        : false;

    if (!solved) {
      const issued = issueChallenge({ secret, difficulty, fingerprint, ttlMs, algorithm });
      throw new PowRequiredError(issued.token, issued.difficulty, issued.algorithm);
    }
  }

  // 7. Allowed. Debit now (immediate) or hand the caller a settle().
  if (options.defer) {
    return { settle: deduct };
  }
  await deduct();
  return NOOP_GATE;
};

interface DifficultyResolution {
  reason: "endpoint" | "budget";
  base: number;
  hook?: (ctx: PowDifficultyContext) => number | Promise<number>;
  cost?: number;
  available?: number;
  deficit?: number;
}

const captchaContext = (c: Context, options: EnforceAbuseOptions): CaptchaContext => ({
  c,
  user: getUser(c),
  ip: getClientIP(c),
  operation: options.operation,
  resource: options.resource,
  reason: "endpoint",
});

const resolveDifficulty = async (
  c: Context,
  options: EnforceAbuseOptions,
  _pow: PowConfig | null,
  res: DifficultyResolution
): Promise<number> => {
  if (!res.hook) return res.base;
  return res.hook({
    c,
    user: getUser(c),
    ip: getClientIP(c),
    operation: options.operation,
    resource: options.resource,
    baseDifficulty: res.base,
    reason: res.reason,
    cost: res.cost,
    available: res.available,
    deficit: res.deficit,
  });
};
