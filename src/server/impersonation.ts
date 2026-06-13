import type { Context, MiddlewareHandler } from "hono";
import { getUser } from "./context";
import type { UserContext } from "@/resource/types";
import type { AdminBypassPredicate } from "./admin-bypass";

const IMPERSONATE_HEADER = "x-covara-impersonate";

export type ImpersonationUserResolver = (
  userId: string,
  c: Context
) => UserContext | null | Promise<UserContext | null>;

let predicate: AdminBypassPredicate | null = null;
let userResolver: ImpersonationUserResolver | null = null;

export const setImpersonationPredicate = (
  fn: AdminBypassPredicate | null
): void => {
  predicate = fn;
};

export const setImpersonationUserResolver = (
  fn: ImpersonationUserResolver | null
): void => {
  userResolver = fn;
};

export const markImpersonate = (userId: string): Record<string, string> => ({
  [IMPERSONATE_HEADER]: userId,
});

export const getImpersonationTargetId = (c: Context): string | null => {
  const value = c.req.header(IMPERSONATE_HEADER);
  return value != null && value !== "" ? value : null;
};

export const resolveImpersonatedUser = async (
  c: Context
): Promise<UserContext | null> => {
  if (!predicate || !userResolver) return null;
  const targetId = getImpersonationTargetId(c);
  if (targetId == null) return null;
  try {
    if ((await predicate(getUser(c), c)) !== true) return null;
    return await userResolver(targetId, c);
  } catch {
    return null;
  }
};

export const isImpersonationRequest = async (c: Context): Promise<boolean> =>
  (await resolveImpersonatedUser(c)) !== null;

declare module "hono" {
  interface ContextVariableMap {
    impersonatorId?: string;
    impersonatedId?: string;
  }
}

export const createImpersonationMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    // Never swap the user on the admin UI's own routes: those rely on the real
    // authenticated user for admin authorization, and the admin UI resolves
    // impersonation explicitly where it needs it (data explorer, previews).
    if (c.req.path.startsWith("/__covara")) {
      await next();
      return;
    }
    const impersonated = await resolveImpersonatedUser(c);
    if (impersonated) {
      const real = getUser(c);
      c.set("impersonatorId", real?.id);
      c.set("impersonatedId", impersonated.id);
      c.set("user", impersonated);
    }
    await next();
  };
};
