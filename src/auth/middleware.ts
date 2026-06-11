import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  AuthAdapter,
  AuthMiddlewareOptions,
} from "./types";
import { UnauthorizedError } from "@/resource/error";
import { UserContext } from "@/resource/types";
import { getClientIP } from "@/server/request";

export const createAuthMiddleware = (
  adapter: AuthAdapter,
  options: AuthMiddlewareOptions = {}
): MiddlewareHandler => {
  return async (c, next) => {
    if (options.skipPaths) {
      for (const path of options.skipPaths) {
        if (c.req.path.startsWith(path)) {
          return next();
        }
      }
    }

    const extractor = options.extractCredentials ?? adapter.extractCredentials.bind(adapter);
    const credentials = extractor(c);

    if (!credentials) {
      return next();
    }

    const result = await adapter.validateCredentials(credentials);

    if (!result.success) {
      throw new UnauthorizedError(
        result.error ?? options.unauthorizedMessage ?? "Invalid credentials"
      );
    }

    c.set("user", result.user);

    if (credentials.type === "session" && credentials.sessionId) {
      c.set("session", (await adapter.getSession(credentials.sessionId)) ?? undefined);
    } else if (credentials.type === "bearer" && credentials.token) {
      c.set("session", (await adapter.getSession(credentials.token)) ?? undefined);
    }

    return next();
  };
};

export const requireAuth = (
  options: { message?: string } = {}
): MiddlewareHandler => {
  return async (c, next) => {
    if (!c.get("user")) {
      throw new UnauthorizedError(options.message ?? "Authentication required");
    }
    return next();
  };
};

export const optionalAuth = (): MiddlewareHandler => {
  return async (_c, next) => next();
};

export const requirePermission = (permission: string): MiddlewareHandler => {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }

    const permissions = user.metadata?.permissions;
    if (!Array.isArray(permissions) || !permissions.includes(permission)) {
      throw new UnauthorizedError(`Permission '${permission}' required`);
    }

    return next();
  };
};

export const requireRole = (...roles: string[]): MiddlewareHandler => {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }

    const userRole = user.metadata?.role;
    if (typeof userRole !== "string" || !roles.includes(userRole)) {
      throw new UnauthorizedError(`One of roles [${roles.join(", ")}] required`);
    }

    return next();
  };
};

export const requireOwnership = (
  getResourceOwnerId: (c: Context) => string | Promise<string>,
  options: { allowAdmin?: boolean; adminCheck?: (c: Context) => boolean } = {}
): MiddlewareHandler => {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }

    if (options.allowAdmin && options.adminCheck?.(c)) {
      return next();
    }

    const ownerId = await getResourceOwnerId(c);
    if (ownerId !== user.id) {
      throw new UnauthorizedError("You don't own this resource");
    }

    return next();
  };
};

export const refreshSession = (adapter: AuthAdapter): MiddlewareHandler => {
  return async (c, next) => {
    const session = c.get("session");
    if (session && adapter.refreshSession) {
      const refreshed = await adapter.refreshSession(session.id);
      if (refreshed) {
        c.set("session", refreshed);
      }
    }
    return next();
  };
};

export const createLogoutHandler = (adapter: AuthAdapter) => {
  return async (c: Context): Promise<Response> => {
    const session = c.get("session");
    if (session) {
      await adapter.invalidateSession(session.id);
    }

    deleteCookie(c, "session");

    return c.json({ success: true });
  };
};

export const getUser = (c: Context): UserContext | undefined => {
  return c.get("user");
};

export const getSession = (c: Context) => {
  return c.get("session");
};

export const rateByUser = (c: Context): string => {
  return c.get("user")?.id ?? getClientIP(c);
};
