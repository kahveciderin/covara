import type { Context } from "hono";
import { getUser } from "./context";
import type { UserContext } from "@/resource/types";

const BYPASS_HEADER = "x-covara-admin-bypass";

export type AdminBypassPredicate = (
  user: UserContext | null,
  c: Context
) => boolean | Promise<boolean>;

let predicate: AdminBypassPredicate | null = null;

export const setAdminBypassPredicate = (
  fn: AdminBypassPredicate | null
): void => {
  predicate = fn;
};

export const markAdminBypass = (): Record<string, string> => ({
  [BYPASS_HEADER]: "1",
});

export const isAdminBypassRequest = async (c: Context): Promise<boolean> => {
  if (!predicate) return false;
  if (c.req.header(BYPASS_HEADER) == null) return false;
  try {
    return (await predicate(getUser(c), c)) === true;
  } catch {
    return false;
  }
};
