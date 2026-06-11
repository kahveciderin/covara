import type { MiddlewareHandler } from "hono";
import { isProduction } from "@/server/env";

export type FrameOption = "DENY" | "SAMEORIGIN";

export interface HSTSOptions {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false;
  contentTypeOptions?: boolean;
  frameOptions?: FrameOption | false;
  referrerPolicy?: string | false;
  dnsPrefetchControl?: string | false;
  crossOriginOpenerPolicy?: string | false;
  hsts?: HSTSOptions | false;
}

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";
const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
const DEFAULT_DNS_PREFETCH_CONTROL = "off";
const DEFAULT_COOP = "same-origin";
const DEFAULT_HSTS_MAX_AGE = 15552000;

const buildHSTSValue = (opts: HSTSOptions): string => {
  const maxAge = opts.maxAge ?? DEFAULT_HSTS_MAX_AGE;
  const includeSubDomains = opts.includeSubDomains ?? true;
  const parts = [`max-age=${maxAge}`];
  if (includeSubDomains) parts.push("includeSubDomains");
  if (opts.preload) parts.push("preload");
  return parts.join("; ");
};

const isHttpsRequest = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

export const createSecurityHeaders = (
  options: SecurityHeadersOptions = {}
): MiddlewareHandler => {
  const {
    contentSecurityPolicy = DEFAULT_CSP,
    contentTypeOptions = true,
    frameOptions = "DENY",
    referrerPolicy = DEFAULT_REFERRER_POLICY,
    dnsPrefetchControl = DEFAULT_DNS_PREFETCH_CONTROL,
    crossOriginOpenerPolicy = DEFAULT_COOP,
    hsts = {},
  } = options;

  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    const setIfAbsent = (name: string, value: string): void => {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    };

    if (contentTypeOptions) {
      setIfAbsent("X-Content-Type-Options", "nosniff");
    }
    if (frameOptions !== false) {
      setIfAbsent("X-Frame-Options", frameOptions);
    }
    if (referrerPolicy !== false) {
      setIfAbsent("Referrer-Policy", referrerPolicy);
    }
    if (dnsPrefetchControl !== false) {
      setIfAbsent("X-DNS-Prefetch-Control", dnsPrefetchControl);
    }
    if (crossOriginOpenerPolicy !== false) {
      setIfAbsent("Cross-Origin-Opener-Policy", crossOriginOpenerPolicy);
    }
    if (contentSecurityPolicy !== false) {
      setIfAbsent("Content-Security-Policy", contentSecurityPolicy);
    }

    if (hsts !== false && (isHttpsRequest(c.req.url) || isProduction())) {
      setIfAbsent("Strict-Transport-Security", buildHSTSValue(hsts));
    }
  };
};
