/**
 * CAPTCHA providers (BETA). Fetch-based token verification against the common
 * managed providers plus a generic escape hatch. Verification is fail-closed:
 * any network/parse error or a falsy provider result rejects the token.
 *
 * Runs on Node and Cloudflare Workers (uses the global `fetch`, no node deps).
 */

import { getLogger } from "@/server/logger";

export interface CaptchaVerifyContext {
  ip?: string;
  action?: string;
}

export interface CaptchaProvider {
  /** "turnstile" | "hcaptcha" | "recaptcha" | "custom" (or any custom name). */
  name: string;
  /** Public site key, surfaced to the client so it can render the widget. */
  siteKey?: string;
  verify(token: string, ctx?: CaptchaVerifyContext): Promise<boolean>;
}

interface SiteVerifyResponse {
  success?: boolean;
  score?: number;
  action?: string;
  [key: string]: unknown;
}

const postSiteVerify = async (
  url: string,
  fields: Record<string, string | undefined>
): Promise<SiteVerifyResponse | null> => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "") body.set(key, value);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    return (await res.json()) as SiteVerifyResponse;
  } catch (error) {
    getLogger().warn("CAPTCHA verification request failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export interface TurnstileOptions {
  secret: string;
  siteKey?: string;
  verifyUrl?: string;
}

export const turnstile = (options: TurnstileOptions): CaptchaProvider => ({
  name: "turnstile",
  siteKey: options.siteKey,
  async verify(token, ctx) {
    const data = await postSiteVerify(
      options.verifyUrl ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { secret: options.secret, response: token, remoteip: ctx?.ip }
    );
    return data?.success === true;
  },
});

export interface HcaptchaOptions {
  secret: string;
  siteKey?: string;
  verifyUrl?: string;
}

export const hcaptcha = (options: HcaptchaOptions): CaptchaProvider => ({
  name: "hcaptcha",
  siteKey: options.siteKey,
  async verify(token, ctx) {
    const data = await postSiteVerify(
      options.verifyUrl ?? "https://api.hcaptcha.com/siteverify",
      { secret: options.secret, response: token, remoteip: ctx?.ip }
    );
    return data?.success === true;
  },
});

export interface RecaptchaOptions {
  secret: string;
  siteKey?: string;
  /** v3 score threshold (0..1). When set, the score must be >= minScore. */
  minScore?: number;
  verifyUrl?: string;
}

export const recaptcha = (options: RecaptchaOptions): CaptchaProvider => ({
  name: "recaptcha",
  siteKey: options.siteKey,
  async verify(token, ctx) {
    const data = await postSiteVerify(
      options.verifyUrl ?? "https://www.google.com/recaptcha/api/siteverify",
      { secret: options.secret, response: token, remoteip: ctx?.ip }
    );
    if (data?.success !== true) return false;
    if (options.minScore !== undefined && (data.score ?? 0) < options.minScore) {
      return false;
    }
    if (ctx?.action && data.action && data.action !== ctx.action) {
      return false;
    }
    return true;
  },
});

export interface CustomCaptchaOptions {
  name?: string;
  siteKey?: string;
  verify: (token: string, ctx?: CaptchaVerifyContext) => Promise<boolean> | boolean;
}

export const customCaptcha = (options: CustomCaptchaOptions): CaptchaProvider => ({
  name: options.name ?? "custom",
  siteKey: options.siteKey,
  async verify(token, ctx) {
    try {
      return await options.verify(token, ctx);
    } catch (error) {
      getLogger().warn("Custom CAPTCHA verifier threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
});
