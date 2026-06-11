import { createHash } from "node:crypto";
import type { Context } from "hono";
import { PreconditionFailedError } from "./error";

export interface ETagConfig {
  versionField?: string;
  updatedAtField?: string;
  idField?: string;
  algorithm?: "weak" | "strong";
}

const DEFAULT_CONFIG: ETagConfig = {
  updatedAtField: "updatedAt",
  idField: "id",
  // Version numbers, updatedAt timestamps and content hashes are all *strong*
  // validators (they change on every byte-level change), and RFC 7232 requires
  // strong validators for If-Match write preconditions. Default to strong so
  // optimistic concurrency control is correct out of the box.
  algorithm: "strong",
};

export const generateETag = (
  item: Record<string, unknown>,
  config: ETagConfig = DEFAULT_CONFIG
): string => {
  const { versionField, updatedAtField, idField, algorithm } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  let tag: string;

  if (versionField && item[versionField] !== undefined) {
    tag = `${item[versionField]}`;
  } else if (updatedAtField && item[updatedAtField]) {
    const timestamp =
      item[updatedAtField] instanceof Date
        ? (item[updatedAtField] as Date).getTime()
        : typeof item[updatedAtField] === "string"
          ? new Date(item[updatedAtField] as string).getTime()
          : item[updatedAtField];

    const id = idField && item[idField] ? item[idField] : "";
    tag = `${timestamp}-${id}`;
  } else {
    const hash = createHash("md5")
      .update(JSON.stringify(item))
      .digest("hex")
      .slice(0, 16);
    tag = hash;
  }

  return algorithm === "weak" ? `W/"${tag}"` : `"${tag}"`;
};

export const generateStrongETag = (
  item: Record<string, unknown>
): string => {
  const hash = createHash("sha256")
    .update(JSON.stringify(item))
    .digest("hex")
    .slice(0, 32);
  return `"${hash}"`;
};

export const parseETag = (etag: string): { value: string; weak: boolean } | null => {
  if (!etag || typeof etag !== "string") {
    return null;
  }

  const trimmed = etag.trim();

  if (trimmed.startsWith('W/"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(3, -1),
      weak: true,
    };
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(1, -1),
      weak: false,
    };
  }

  return null;
};

export const compareETags = (
  clientETag: string,
  serverETag: string,
  weakComparison: boolean = true
): boolean => {
  const client = parseETag(clientETag);
  const server = parseETag(serverETag);

  if (!client || !server) {
    return false;
  }

  if (!weakComparison && (client.weak || server.weak)) {
    return false;
  }

  return client.value === server.value;
};

export const validateIfMatch = (
  ifMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): void => {
  if (!ifMatch) {
    return;
  }

  const currentETag = generateETag(item, config);

  if (ifMatch === "*") {
    return;
  }

  const eTags = ifMatch.split(",").map((e) => e.trim());

  // RFC 7232 §3.1: If-Match requires the strong comparison function.
  const matches = eTags.some((tag) => compareETags(tag, currentETag, false));

  if (!matches) {
    throw new PreconditionFailedError(currentETag);
  }
};

export const validateIfNoneMatch = (
  ifNoneMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): boolean => {
  if (!ifNoneMatch) {
    return false;
  }

  const currentETag = generateETag(item, config);

  if (ifNoneMatch === "*") {
    return true;
  }

  const eTags = ifNoneMatch.split(",").map((e) => e.trim());

  return eTags.some((tag) => compareETags(tag, currentETag, true));
};

export const setETagHeader = (
  c: Context,
  item: Record<string, unknown>,
  config?: ETagConfig
): void => {
  const etag = generateETag(item, config);
  c.header("ETag", etag);
};

export const handleConditionalGet = (
  c: Context,
  ifNoneMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): Response | null => {
  const etag = generateETag(item, config);
  c.header("ETag", etag);

  if (ifNoneMatch && compareETags(ifNoneMatch, etag, true)) {
    return c.body(null, 304);
  }

  return null;
};

export interface ConditionalWriteResult {
  shouldProceed: boolean;
  currentETag?: string;
}

export const checkConditionalWrite = (
  ifMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): ConditionalWriteResult => {
  const currentETag = generateETag(item, config);

  if (!ifMatch) {
    return { shouldProceed: true, currentETag };
  }

  if (ifMatch === "*") {
    return { shouldProceed: true, currentETag };
  }

  const eTags = ifMatch.split(",").map((e) => e.trim());
  // RFC 7232 §3.1: If-Match requires the strong comparison function.
  const matches = eTags.some((tag) => compareETags(tag, currentETag, false));

  return { shouldProceed: matches, currentETag };
};

export const addETagsToList = <T extends Record<string, unknown>>(
  items: T[],
  config?: ETagConfig
): (T & { _etag: string })[] => {
  return items.map((item) => ({
    ...item,
    _etag: generateETag(item, config),
  }));
};

export type ReturnPreference = "representation" | "minimal";

export const parseReturnPreference = (
  query: Record<string, unknown>
): ReturnPreference => {
  const returnParam = query.return as string | undefined;
  if (returnParam === "minimal") {
    return "minimal";
  }
  return "representation";
};

export const handleReturnPreference = (
  c: Context,
  item: Record<string, unknown>,
  preference: ReturnPreference,
  config?: ETagConfig
): Response => {
  const etag = generateETag(item, config);
  c.header("ETag", etag);

  if (preference === "minimal") {
    return c.body(null, 204);
  }
  return c.json(item);
};
