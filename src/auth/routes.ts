import { Hono, type Context, type MiddlewareHandler } from "hono";
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
import { createSocialRouter, type SocialAuthOptions } from "./social";
import { fromAuthAdapter, type SessionStrategy } from "./session";

// Request metadata stored in session.data so the admin UI can show where a
// session came from. Lives inside `data` because every session store already
// persists that field unchanged.
const sessionRequestMeta = (c: Context): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  const ip = getClientIP(c);
  if (ip) meta.ipAddress = ip;
  const ua = c.req.header("user-agent");
  if (ua) meta.userAgent = ua;
  return meta;
};

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface UseAuthOptions {
  // How the authenticated identity is persisted, validated per request, and
  // issued at login — `cookieSession(...)` or `jwtSession(...)`. Decoupled from
  // the credential providers below, so any provider works with any session type.
  session?: SessionStrategy;
  // Deprecated: pass a legacy AuthAdapter instead of `session`. Kept working via
  // an internal shim; prefer `session`.
  adapter?: AuthAdapter;
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
  // Social login via any Passport.js OAuth2 strategy (github, discord, google,
  // ...). Mounts redirect + callback routes that mint the same session as a
  // password login. See `fromPassport`.
  social?: SocialAuthOptions;
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
    session: sessionOption,
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
    social,
  } = options;

  const finalCookieOptions = {
    ...defaultCookieOptions,
    secure: isProduction(),
    ...cookieOptions,
  };

  const strategy: SessionStrategy =
    sessionOption ??
    (adapter
      ? fromAuthAdapter(adapter, {
          name: cookieName,
          options: toCookieOptions(finalCookieOptions),
        })
      : (() => {
          throw new Error(
            "useAuth requires a `session` strategy (cookieSession/jwtSession) or a legacy `adapter`."
          );
        })());

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

  // Mint a session/token via the configured strategy and assemble the JSON body.
  // Returns null only if issuance fails, preserving the prior contract.
  const issueLogin = async (
    c: Context,
    userId: string
  ): Promise<{ body: Record<string, unknown>; user: UserContext } | null> => {
    try {
      const issued = await strategy.issue(c, userId, sessionRequestMeta(c));
      const body: Record<string, unknown> = { user: serializeUser(issued.user) };
      if (issued.sessionId) body.sessionId = issued.sessionId;
      if (issued.accessToken) {
        body.accessToken = issued.accessToken;
        body.expiresIn = issued.expiresIn;
        body.tokenType = "Bearer";
      }
      return { body, user: issued.user };
    } catch {
      return null;
    }
  };

  const completeLogin = async (
    c: Context,
    userId: string
  ): Promise<Record<string, unknown> | null> => {
    const issued = await issueLogin(c, userId);
    if (!issued) return null;

    if (csrfOptions) {
      issueCsrfToken(c, csrfOptions);
    }

    await onLogin?.(issued.user, c);

    return issued.body;
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
      const result = await strategy.authenticate(c);
      if (result.success && result.user) {
        c.set("user", result.user);
      }
      return next();
    } catch {
      return next();
    }
  };

  router.get("/me", async (c) => {
    try {
      const result = await strategy.authenticate(c);
      if (!result.success || !result.user) {
        return c.json({ user: null });
      }
      return c.json({ user: serializeUser(result.user), expiresAt: result.expiresAt });
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

      const issued = await issueLogin(c, user.id);
      if (!issued) {
        throw new UnauthorizedError("Failed to create session");
      }
      await onSignup?.(user, c);

      // Preserve the original `user` shape; merge in any session/token artifacts.
      const body: Record<string, unknown> = {
        user: { id: user.id, email: user.email, name: user.name },
      };
      if (issued.body.sessionId) body.sessionId = issued.body.sessionId;
      if (issued.body.accessToken) {
        body.accessToken = issued.body.accessToken;
        body.expiresIn = issued.body.expiresIn;
        body.tokenType = "Bearer";
      }
      return c.json(body);
    });
  }

  router.post("/logout", async (c) => {
    try {
      let user: UserContext | null = null;
      const result = await strategy.authenticate(c);
      if (result.success && result.user) {
        user = result.user;
      }

      await strategy.logout(c);
      await onLogout?.(user, c);

      return c.json({ success: true });
    } catch {
      await strategy.logout(c).catch(() => {});
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
        if (user && strategy.invalidateUserSessions) {
          await strategy.invalidateUserSessions(user.id);
        }
      }

      return c.json({ success: true });
    });
  }

  if (mfa) {
    const requireCurrentUser = async (c: Context): Promise<UserContext> => {
      const result = await strategy.authenticate(c);
      if (result.success && result.user) {
        return result.user;
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

  if (social) {
    const socialRouter = createSocialRouter(social, {
      completeLogin,
      cookieSecure: finalCookieOptions.secure,
      cookiePath: finalCookieOptions.path,
    });
    router.route(social.basePath ?? "/social", socialRouter);
  }

  // Strategy-owned routes (e.g. JWT `/refresh`).
  if (strategy.getRoutes) {
    router.route("/", strategy.getRoutes());
  }

  return { router, middleware };
};

export const createAuthRoutes = useAuth;
