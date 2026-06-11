import type { Context } from "hono";
import type { UserContext } from "@/resource/types";
import type { SessionData } from "@/auth/types";
import { UnauthorizedError } from "@/resource/error";

declare module "hono" {
  interface ContextVariableMap {
    user?: UserContext;
    session?: SessionData;
    requestId?: string;
    apiVersion?: string;
  }
}

export const getUser = (c: Context): UserContext | null => c.get("user") ?? null;

export const getSession = (c: Context): SessionData | null => c.get("session") ?? null;

export const requireUser = (c: Context): UserContext => {
  const user = c.get("user");
  if (!user) {
    throw new UnauthorizedError("Authentication required");
  }
  return user;
};

export const isAuthenticated = (c: Context): boolean => c.get("user") !== undefined;
