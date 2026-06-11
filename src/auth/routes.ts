import { Hono, type Context, type MiddlewareHandler } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { AuthAdapter } from "./types";
import { UnauthorizedError, ValidationError, RateLimitError } from "@/resource/error";
import { UserContext } from "@/resource/types";
import { readJsonBody, getClientIP } from "@/server/request";
import { isProduction } from "@/server/env";
import { LoginThrottle, type LoginThrottleOptions } from "./login-throttle";
import { createCsrfMiddleware, issueCsrfToken, type CsrfOptions } from "./csrf";
import {
  VerificationTokenStore,
  issueToken as issueVerificationToken,
  verifyToken as verifyVerificationToken,
} from "./verification";
import {
  issuePasswordResetToken,
  verifyPasswordResetToken,
  hashNewPassword,
} from "./password-reset";
import {
  generateTotpSecret,
  getTotpUri,
  verifyTotp,
  generateBackupCodes,
  verifyBackupCode,
  type TotpOptions,
} from "./totp";
import { issueMagicLinkToken, consumeMagicLinkToken } from "./magic-link";
import {
  enforcePasswordStrength,
  type PasswordPolicyOptions,
} from "./password-policy";

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface UseAuthOptions {
  adapter: AuthAdapter;
  cookieName?: string;
  cookieOptions?: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    maxAge?: number;
    path?: string;
  };
  login?: {
    validateCredentials: (email: string, password: string) => Promise<AuthUser | null>;
  };
  signup?: {
    createUser: (data: { email: string; password: string; name?: string }) => Promise<AuthUser>;
    validateEmail?: (email: string) => boolean | Promise<boolean>;
    validatePassword?: (password: string) => boolean | Promise<boolean>;
  };
  serializeUser?: (user: UserContext) => Record<string, unknown>;
  onLogin?: (user: UserContext, c: Context) => void | Promise<void>;
  onLogout?: (user: UserContext | null, c: Context) => void | Promise<void>;
  onSignup?: (user: AuthUser, c: Context) => void | Promise<void>;
  csrf?: boolean | CsrfOptions;
  throttle?: boolean | LoginThrottleOptions;
  verification?: {
    store: VerificationTokenStore;
    sendToken: (params: {
      identifier: string;
      token: string;
      expiresAt: Date;
      c: Context;
    }) => void | Promise<void>;
    markVerified: (identifier: string) => void | Promise<void>;
    ttlMs?: number;
    hashTokens?: boolean;
  };
  passwordReset?: {
    store: VerificationTokenStore;
    sendToken: (params: {
      identifier: string;
      token: string;
      expiresAt: Date;
      c: Context;
    }) => void | Promise<void>;
    resetPassword: (identifier: string, passwordHash: string) => void | Promise<void>;
    findUserByEmail?: (identifier: string) => Promise<{ id: string } | null>;
    ttlMs?: number;
    hashTokens?: boolean;
    logoutEverywhere?: boolean;
  };
  passwordPolicy?: PasswordPolicyOptions;
  mfa?: MfaOptions;
  magicLink?: MagicLinkAuthOptions;
}

export interface MfaEnrollment {
  secret: string;
  enabled: boolean;
  backupCodeHashes?: string[];
}

export interface MfaOptions {
  issuer?: string;
  totp?: TotpOptions;
  backupCodeCount?: number;
  requireOnLogin?: boolean;
  getUserByEmail: (email: string) => Promise<(AuthUser & { mfa?: MfaEnrollment | null }) | null>;
  getEnrollment: (userId: string) => Promise<MfaEnrollment | null>;
  saveEnrollment: (userId: string, enrollment: MfaEnrollment) => void | Promise<void>;
  saveBackupCodeHashes?: (userId: string, hashes: string[]) => void | Promise<void>;
  consumeBackupCode?: (userId: string, index: number) => void | Promise<void>;
}

export interface MagicLinkAuthOptions {
  store: VerificationTokenStore;
  sendLink: (params: {
    identifier: string;
    token: string;
    expiresAt: Date;
    c: Context;
  }) => void | Promise<void>;
  findUserByEmail: (identifier: string) => Promise<AuthUser | null>;
  ttlMs?: number;
  hashTokens?: boolean;
}

export interface AuthRouterResult {
  router: Hono;
  middleware: MiddlewareHandler;
}

const defaultCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

const defaultSerializeUser = (user: UserContext): Record<string, unknown> => ({
  id: user.id,
  email: user.email,
  name: user.name,
  image: user.image,
});

interface LoginBody {
  email?: string;
  password?: string;
  name?: string;
}

const toCookieOptions = (
  options: UseAuthOptions["cookieOptions"] & { expires?: Date }
): CookieOptions => ({
  httpOnly: options?.httpOnly,
  secure: options?.secure,
  sameSite: options?.sameSite,
  path: options?.path,
  maxAge: options?.maxAge !== undefined ? Math.floor(options.maxAge / 1000) : undefined,
  expires: options?.expires,
});

export const useAuth = (options: UseAuthOptions): AuthRouterResult => {
  const {
    adapter,
    cookieName = "session",
    cookieOptions = {},
    login,
    signup,
    serializeUser = defaultSerializeUser,
    onLogin,
    onLogout,
    onSignup,
    csrf,
    throttle,
    verification,
    passwordReset,
    passwordPolicy,
    mfa,
    magicLink,
  } = options;

  const finalCookieOptions = {
    ...defaultCookieOptions,
    secure: isProduction(),
    ...cookieOptions,
  };
  const router = new Hono();

  const csrfOptions: CsrfOptions | null = csrf
    ? typeof csrf === "object"
      ? csrf
      : {}
    : null;
  const csrfMiddleware = csrfOptions ? createCsrfMiddleware(csrfOptions) : null;
  if (csrfMiddleware) {
    router.use("*", csrfMiddleware);
  }

  const throttle$ = throttle
    ? new LoginThrottle(typeof throttle === "object" ? throttle : {})
    : null;

  const completeLogin = async (
    c: Context,
    userId: string
  ): Promise<{ user: Record<string, unknown>; sessionId: string } | null> => {
    if (!adapter.createSession) {
      throw new Error("Adapter does not support session creation");
    }

    const priorSessionId = getCookie(c, cookieName);
    if (priorSessionId) {
      await adapter.invalidateSession(priorSessionId);
    }

    const session = await adapter.createSession(userId);
    const authResult = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    if (!authResult.success || !authResult.user) {
      return null;
    }

    setCookie(c, cookieName, session.id, toCookieOptions({
      ...finalCookieOptions,
      expires: session.expiresAt,
    }));

    if (csrfOptions) {
      issueCsrfToken(c, csrfOptions);
    }

    await onLogin?.(authResult.user, c);

    return { user: serializeUser(authResult.user), sessionId: session.id };
  };

  const verifyMfaChallenge = async (
    enrollment: MfaEnrollment,
    userId: string,
    code: string
  ): Promise<boolean> => {
    if (!mfa) return false;
    if (verifyTotp(enrollment.secret, code, mfa.totp)) {
      return true;
    }
    const hashes = enrollment.backupCodeHashes ?? [];
    if (hashes.length === 0) return false;
    const result = await verifyBackupCode(code, hashes);
    if (result.matched) {
      await mfa.consumeBackupCode?.(userId, result.index);
      return true;
    }
    return false;
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    try {
      const credentials = adapter.extractCredentials(c);
      if (!credentials) {
        return next();
      }

      const result = await adapter.validateCredentials(credentials);
      if (!result.success || !result.user) {
        return next();
      }

      c.set("user", result.user);
      return next();
    } catch {
      return next();
    }
  };

  router.get("/me", async (c) => {
    try {
      const credentials = adapter.extractCredentials(c);
      if (!credentials) {
        return c.json({ user: null });
      }

      const result = await adapter.validateCredentials(credentials);
      if (!result.success || !result.user) {
        return c.json({ user: null });
      }

      const serialized = serializeUser(result.user);
      return c.json({ user: serialized, expiresAt: result.expiresAt });
    } catch {
      return c.json({ user: null });
    }
  });

  if (login?.validateCredentials) {
    router.post("/login", async (c) => {
      const body = (await readJsonBody(c)) as LoginBody & { mfaCode?: string };
      const { email, password, mfaCode } = body;

      if (!email || !password) {
        throw new ValidationError("Email and password are required");
      }

      const ip = getClientIP(c);

      if (throttle$) {
        const status = await throttle$.check(email, ip);
        if (status.locked) {
          throw new RateLimitError(
            status.retryAfterSeconds,
            "Too many login attempts, please try again later"
          );
        }
      }

      const user = await login.validateCredentials(email, password);
      if (!user) {
        if (throttle$) {
          await throttle$.recordFailure(email, ip);
        }
        throw new UnauthorizedError("Invalid email or password");
      }

      if (mfa?.requireOnLogin) {
        const enrollment = await mfa.getEnrollment(user.id);
        if (enrollment?.enabled) {
          if (!mfaCode) {
            return c.json({ mfaRequired: true }, 401);
          }
          const ok = await verifyMfaChallenge(enrollment, user.id, mfaCode);
          if (!ok) {
            if (throttle$) {
              await throttle$.recordFailure(email, ip);
            }
            throw new UnauthorizedError("Invalid MFA code");
          }
        }
      }

      const result = await completeLogin(c, user.id);
      if (!result) {
        throw new UnauthorizedError("Failed to create session");
      }

      if (throttle$) {
        await throttle$.reset(email, ip);
      }

      return c.json(result);
    });
  }

  if (signup?.createUser) {
    router.post("/signup", async (c) => {
      const { email, password, name } = (await readJsonBody(c)) as LoginBody;

      if (!email || !password) {
        throw new ValidationError("Email and password are required");
      }

      if (signup.validateEmail) {
        const isValidEmail = await signup.validateEmail(email);
        if (!isValidEmail) {
          throw new ValidationError("Invalid email format");
        }
      }

      if (passwordPolicy) {
        enforcePasswordStrength(password, passwordPolicy);
      }

      if (signup.validatePassword) {
        const isValidPassword = await signup.validatePassword(password);
        if (!isValidPassword) {
          throw new ValidationError("Password does not meet requirements");
        }
      }

      const user = await signup.createUser({ email, password, name });

      if (!adapter.createSession) {
        throw new Error("Adapter does not support session creation");
      }

      const session = await adapter.createSession(user.id);

      setCookie(c, cookieName, session.id, toCookieOptions({
        ...finalCookieOptions,
        expires: session.expiresAt,
      }));

      await onSignup?.(user, c);

      return c.json({ user: { id: user.id, email: user.email, name: user.name } });
    });
  }

  router.post("/logout", async (c) => {
    try {
      const credentials = adapter.extractCredentials(c);
      let user: UserContext | null = null;

      if (credentials) {
        const result = await adapter.validateCredentials(credentials);
        if (result.success && result.user) {
          user = result.user;
        }

        const sessionToken = credentials.sessionId ?? credentials.token;
        if (sessionToken) {
          await adapter.invalidateSession(sessionToken);
        }
      }

      deleteCookie(c, cookieName);
      deleteCookie(c, "connect.sid");
      deleteCookie(c, "session");

      await onLogout?.(user, c);

      return c.json({ success: true });
    } catch {
      deleteCookie(c, cookieName);
      return c.json({ success: true });
    }
  });

  if (verification) {
    router.post("/verify/request", async (c) => {
      const { email } = (await readJsonBody(c)) as LoginBody;
      if (!email) {
        throw new ValidationError("Email is required");
      }

      const { token, expiresAt } = await issueVerificationToken(
        verification.store,
        email,
        verification.ttlMs ?? 24 * 60 * 60 * 1000,
        { hash: verification.hashTokens }
      );

      await verification.sendToken({ identifier: email, token, expiresAt, c });

      return c.json({ success: true });
    });

    router.post("/verify/confirm", async (c) => {
      const { email, token } = (await readJsonBody(c)) as LoginBody & { token?: string };
      if (!email || !token) {
        throw new ValidationError("Email and token are required");
      }

      const valid = await verifyVerificationToken(verification.store, email, token, {
        hash: verification.hashTokens,
      });

      if (!valid) {
        throw new ValidationError("Invalid or expired token");
      }

      await verification.markVerified(email);

      return c.json({ success: true });
    });
  }

  if (passwordReset) {
    router.post("/password/forgot", async (c) => {
      const { email } = (await readJsonBody(c)) as LoginBody;
      if (!email) {
        throw new ValidationError("Email is required");
      }

      const exists = passwordReset.findUserByEmail
        ? (await passwordReset.findUserByEmail(email)) !== null
        : true;

      if (exists) {
        const { token, expiresAt } = await issuePasswordResetToken(email, {
          store: passwordReset.store,
          ttlMs: passwordReset.ttlMs,
          hashTokens: passwordReset.hashTokens,
        });
        await passwordReset.sendToken({ identifier: email, token, expiresAt, c });
      }

      return c.json({ success: true });
    });

    router.post("/password/reset", async (c) => {
      const { email, token, password } = (await readJsonBody(c)) as LoginBody & {
        token?: string;
      };
      if (!email || !token || !password) {
        throw new ValidationError("Email, token and password are required");
      }

      if (passwordPolicy) {
        enforcePasswordStrength(password, passwordPolicy);
      }

      const valid = await verifyPasswordResetToken(email, token, {
        store: passwordReset.store,
        ttlMs: passwordReset.ttlMs,
        hashTokens: passwordReset.hashTokens,
      });

      if (!valid) {
        throw new ValidationError("Invalid or expired token");
      }

      const passwordHash = await hashNewPassword(password);
      await passwordReset.resetPassword(email, passwordHash);

      if (passwordReset.logoutEverywhere && passwordReset.findUserByEmail) {
        const user = await passwordReset.findUserByEmail(email);
        if (user && adapter.invalidateUserSessions) {
          await adapter.invalidateUserSessions(user.id);
        }
      }

      return c.json({ success: true });
    });
  }

  if (mfa) {
    const requireCurrentUser = async (c: Context): Promise<UserContext> => {
      const credentials = adapter.extractCredentials(c);
      if (credentials) {
        const result = await adapter.validateCredentials(credentials);
        if (result.success && result.user) {
          return result.user;
        }
      }
      throw new UnauthorizedError("Authentication required");
    };

    router.post("/mfa/enroll", async (c) => {
      const user = await requireCurrentUser(c);
      const secret = generateTotpSecret();
      const { codes, hashes } = await generateBackupCodes(mfa.backupCodeCount ?? 10);

      await mfa.saveEnrollment(user.id, {
        secret,
        enabled: false,
        backupCodeHashes: hashes,
      });
      await mfa.saveBackupCodeHashes?.(user.id, hashes);

      const otpauthUri = getTotpUri({
        secret,
        account: user.email ?? user.id,
        issuer: mfa.issuer,
        digits: mfa.totp?.digits,
        step: mfa.totp?.step,
      });

      return c.json({ secret, otpauthUri, backupCodes: codes });
    });

    router.post("/mfa/enroll/confirm", async (c) => {
      const user = await requireCurrentUser(c);
      const { code } = (await readJsonBody(c)) as { code?: string };
      if (!code) {
        throw new ValidationError("Code is required");
      }

      const enrollment = await mfa.getEnrollment(user.id);
      if (!enrollment) {
        throw new ValidationError("No pending MFA enrollment");
      }

      if (!verifyTotp(enrollment.secret, code, mfa.totp)) {
        throw new ValidationError("Invalid MFA code");
      }

      await mfa.saveEnrollment(user.id, { ...enrollment, enabled: true });

      return c.json({ success: true, enabled: true });
    });

    router.post("/mfa/verify", async (c) => {
      const { email, code } = (await readJsonBody(c)) as {
        email?: string;
        code?: string;
      };
      if (!email || !code) {
        throw new ValidationError("Email and code are required");
      }

      const found = await mfa.getUserByEmail(email);
      const enrollment = found
        ? found.mfa ?? (await mfa.getEnrollment(found.id))
        : null;

      if (!found || !enrollment?.enabled) {
        throw new UnauthorizedError("Invalid MFA code");
      }

      const ok = await verifyMfaChallenge(enrollment, found.id, code);
      if (!ok) {
        throw new UnauthorizedError("Invalid MFA code");
      }

      const result = await completeLogin(c, found.id);
      if (!result) {
        throw new UnauthorizedError("Failed to create session");
      }

      return c.json(result);
    });
  }

  if (magicLink) {
    router.post("/magic-link/request", async (c) => {
      const { email } = (await readJsonBody(c)) as LoginBody;
      if (!email) {
        throw new ValidationError("Email is required");
      }

      const user = await magicLink.findUserByEmail(email);
      if (user) {
        const { token, expiresAt } = await issueMagicLinkToken(email, {
          store: magicLink.store,
          ttlMs: magicLink.ttlMs,
          hashTokens: magicLink.hashTokens,
        });
        await magicLink.sendLink({ identifier: email, token, expiresAt, c });
      }

      return c.json({ success: true });
    });

    router.post("/magic-link/verify", async (c) => {
      const { email, token } = (await readJsonBody(c)) as LoginBody & {
        token?: string;
      };
      if (!email || !token) {
        throw new ValidationError("Email and token are required");
      }

      const valid = await consumeMagicLinkToken(email, token, {
        store: magicLink.store,
        hashTokens: magicLink.hashTokens,
      });
      if (!valid) {
        throw new UnauthorizedError("Invalid or expired token");
      }

      const user = await magicLink.findUserByEmail(email);
      if (!user) {
        throw new UnauthorizedError("Invalid or expired token");
      }

      const result = await completeLogin(c, user.id);
      if (!result) {
        throw new UnauthorizedError("Failed to create session");
      }

      return c.json(result);
    });
  }

  return { router, middleware };
};

export const createAuthRoutes = useAuth;
