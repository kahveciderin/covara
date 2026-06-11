import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ForbiddenError } from "@/resource/error";
import { isProduction } from "@/server/env";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_COOKIE_NAME = "csrf_token";
const DEFAULT_HEADER_NAME = "X-CSRF-Token";

export interface CsrfOptions {
  cookieName?: string;
  headerName?: string;
  tokenLength?: number;
  cookieOptions?: {
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    path?: string;
    maxAge?: number;
  };
  skip?: (c: Context) => boolean;
  message?: string;
}

export const generateCsrfToken = (length = 32): string =>
  randomBytes(length).toString("base64url");

const isBearerRequest = (c: Context): boolean => {
  const authHeader = c.req.header("authorization");
  return typeof authHeader === "string" && authHeader.length > 0;
};

const constantTimeEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
};

export const issueCsrfToken = (c: Context, options: CsrfOptions = {}): string => {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const token = generateCsrfToken(options.tokenLength ?? 32);
  const cookieOptions: CookieOptions = {
    httpOnly: false,
    secure: options.cookieOptions?.secure ?? isProduction(),
    sameSite: options.cookieOptions?.sameSite ?? "lax",
    path: options.cookieOptions?.path ?? "/",
    maxAge: options.cookieOptions?.maxAge,
  };
  setCookie(c, cookieName, token, cookieOptions);
  return token;
};

export const createCsrfMiddleware = (options: CsrfOptions = {}): MiddlewareHandler => {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const headerName = options.headerName ?? DEFAULT_HEADER_NAME;
  const message = options.message ?? "CSRF token validation failed";

  return async (c, next) => {
    if (options.skip?.(c)) {
      return next();
    }

    const method = c.req.method.toUpperCase();

    if (!UNSAFE_METHODS.has(method)) {
      if (!getCookie(c, cookieName)) {
        issueCsrfToken(c, options);
      }
      return next();
    }

    if (isBearerRequest(c)) {
      return next();
    }

    const cookieToken = getCookie(c, cookieName);
    const headerToken = c.req.header(headerName.toLowerCase());

    if (!cookieToken || !headerToken || !constantTimeEquals(cookieToken, headerToken)) {
      throw new ForbiddenError(message);
    }

    return next();
  };
};
