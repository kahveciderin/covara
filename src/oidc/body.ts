import type { Context } from "hono";
import { readJsonBody } from "@/server/request";

export const readFormBody = async (
  c: Context
): Promise<Record<string, string>> => {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await readJsonBody(c);
    if (!body || typeof body !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  }

  const parsed = await c.req.parseBody();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
};
