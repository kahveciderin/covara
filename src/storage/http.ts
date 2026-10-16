import type { Context } from "hono";
import { ResourceError } from "@/resource/error";
import { isActiveContentType } from "./sniff";

export const DOWNLOAD_CSP = "default-src 'none'; sandbox";

export const attachmentDisposition = (filename: string): string => {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

export const safeResponseContentType = (mimeType: string | null | undefined): string => {
  const type = mimeType?.trim() || "application/octet-stream";
  return isActiveContentType(type) ? "application/octet-stream" : type;
};

export const payloadTooLarge = (message: string, details?: unknown): ResourceError =>
  new ResourceError(message, 413, "PAYLOAD_TOO_LARGE", details);

export const readBodyCapped = async (c: Context, maxBytes: number): Promise<Buffer> => {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, { maxBytes, received: declared });
  }
  const body = c.req.raw.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, { maxBytes });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};
