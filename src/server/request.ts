import type { Context } from "hono";
import { ValidationError } from "@/resource/error";

interface NodeIncoming {
  incoming?: { socket?: { remoteAddress?: string } };
}

export const getClientIP = (c: Context): string => {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;

  const nodeEnv = c.env as NodeIncoming | undefined;
  return nodeEnv?.incoming?.socket?.remoteAddress ?? "unknown";
};

export const readJsonBody = async (c: Context): Promise<unknown> => {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
};
