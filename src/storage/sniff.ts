export const SNIFF_BYTES = 4096;

export type ContentSniffingPolicy = "enforce" | "lenient" | "trust-declared";

export type SniffFamily =
  | "image"
  | "pdf"
  | "zip"
  | "gzip"
  | "isobmff"
  | "webm"
  | "mp3"
  | "wav"
  | "ogg"
  | "active"
  | "text"
  | "binary"
  | "empty";

export interface SniffResult {
  mimeType: string;
  family: SniffFamily;
  magic: boolean;
  active: boolean;
}

export interface ContentTypeDecision {
  mimeType: string;
  sniffed: SniffResult | null;
  declared: string | null;
  rejected: boolean;
  reason?: "active_content_mismatch" | "signature_mismatch" | "polyglot";
}

const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-shockwave-flash",
]);

const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown"]);

const MAGIC_DECLARED: Record<string, SniffFamily> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/pjpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "isobmff",
  "image/heic": "isobmff",
  "image/heif": "isobmff",
  "image/bmp": "image",
  "image/x-icon": "image",
  "image/vnd.microsoft.icon": "image",
  "image/tiff": "image",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gzip",
  "application/x-gzip": "gzip",
  "video/mp4": "isobmff",
  "video/quicktime": "isobmff",
  "audio/mp4": "isobmff",
  "audio/x-m4a": "isobmff",
  "video/x-m4v": "isobmff",
  "video/webm": "webm",
  "audio/webm": "webm",
  "video/x-matroska": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "video/ogg": "ogg",
  "application/ogg": "ogg",
};

const ZIP_CONTAINER_TYPES = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.oasis.opendocument.",
  "application/epub+zip",
  "application/java-archive",
  "application/vnd.android.package-archive",
];

const IMAGE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/vnd.microsoft.icon": "image/x-icon",
};

export const normalizeContentType = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0].trim().toLowerCase();

export const isActiveContentType = (value: string | null | undefined): boolean => {
  const type = normalizeContentType(value);
  return ACTIVE_TYPES.has(type) || type.endsWith("+xml");
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
};

const ascii = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i]);
  return out;
};

const result = (mimeType: string, family: SniffFamily, magic = true): SniffResult => ({
  mimeType,
  family,
  magic,
  active: family === "active",
});

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

const sniffFtyp = (bytes: Uint8Array): SniffResult | null => {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return null;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const brands = [ascii(bytes, 8, 12)];
  const end = Math.min(boxSize >= 16 ? boxSize : 16, bytes.length);
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, i + 4));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return result("image/avif", "isobmff");
  if (brands.some((b) => HEIC_BRANDS.has(b))) return result("image/heic", "isobmff");
  if (brands.some((b) => HEIF_BRANDS.has(b))) return result("image/heif", "isobmff");
  if (brands[0] === "qt  ") return result("video/quicktime", "isobmff");
  if (brands[0] === "M4A " || brands[0] === "M4B ") return result("audio/mp4", "isobmff");
  return result("video/mp4", "isobmff");
};

const skipLeadingWhitespace = (bytes: Uint8Array): number => {
  let i = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x0c)) i++;
  return i;
};

const HTML_TAGS = [
  "!doctype html",
  "html",
  "head",
  "script",
  "iframe",
  "h1",
  "div",
  "font",
  "table",
  "a",
  "style",
  "title",
  "b",
  "body",
  "br",
  "p",
  "!--",
  "meta",
  "link",
  "img",
  "object",
  "embed",
  "form",
  "svg",
];

const isTagTerminator = (code: number | undefined): boolean =>
  code === undefined || code === 0x20 || code === 0x3e || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x2f;

const sniffMarkup = (bytes: Uint8Array): SniffResult | null => {
  const start = skipLeadingWhitespace(bytes);
  if (bytes[start] !== 0x3c) return null;
  const head = ascii(bytes, start + 1, start + 64).toLowerCase();
  if (head.startsWith("?xml")) {
    const sample = ascii(bytes, start, Math.min(bytes.length, SNIFF_BYTES)).toLowerCase();
    if (/<svg[\s>/]/.test(sample)) return result("image/svg+xml", "active");
    if (/<html[\s>/]/.test(sample) || sample.includes("http://www.w3.org/1999/xhtml")) {
      return result("application/xhtml+xml", "active");
    }
    return result("application/xml", "active");
  }
  for (const tag of HTML_TAGS) {
    if (head.startsWith(tag) && (tag === "!--" || isTagTerminator(bytes[start + 1 + tag.length]))) {
      return tag === "svg" ? result("image/svg+xml", "active") : result("text/html", "active");
    }
  }
  return null;
};

const POLYGLOT_MARKERS = ["<script", "<html", "<svg", "<iframe", "<body", "<!doctype html", "<?xml", "javascript:"];

export const containsActiveMarkup = (bytes: Uint8Array): boolean => {
  const sample = ascii(bytes, 0, Math.min(bytes.length, SNIFF_BYTES)).toLowerCase();
  return POLYGLOT_MARKERS.some((marker) => sample.includes(marker));
};

const decodeUtf8 = (bytes: Uint8Array, complete: boolean): string | null => {
  let view = bytes;
  if (!complete) {
    let cut = view.length;
    let back = 0;
    while (back < 4 && cut - back - 1 >= 0 && (view[cut - back - 1] & 0xc0) === 0x80) back++;
    if (cut - back - 1 >= 0 && view[cut - back - 1] >= 0xc0) cut = cut - back - 1;
    view = view.subarray(0, cut);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return null;
  }
};

const sniffText = (bytes: Uint8Array, complete: boolean): SniffResult | null => {
  const sample = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return null;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) control++;
  }
  if (control > sample.length * 0.02) return null;
  const text = decodeUtf8(sample, complete && sample.length === bytes.length);
  if (text === null) return null;
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    if (complete && sample.length === bytes.length) {
      try {
        JSON.parse(trimmed);
        return result("application/json", "text", false);
      } catch {
        return result("text/plain", "text", false);
      }
    }
    if (/^[[{]\s*("|\]|\}|\d|-|\[|\{|true|false|null)/.test(trimmed)) {
      return result("application/json", "text", false);
    }
  }
  return result("text/plain", "text", false);
};

export const sniffContentType = (input: Uint8Array, options: { complete?: boolean } = {}): SniffResult => {
  const bytes = input;
  const complete = options.complete ?? true;
  if (bytes.length === 0) return result("application/octet-stream", "empty", false);

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return result("image/png", "image");
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return result("image/jpeg", "image");
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return result("image/gif", "image");
  if (ascii(bytes, 0, 4) === "RIFF" && bytes.length >= 12) {
    const kind = ascii(bytes, 8, 12);
    if (kind === "WEBP") return result("image/webp", "image");
    if (kind === "WAVE") return result("audio/wav", "wav");
    if (kind === "AVI ") return result("video/x-msvideo", "binary");
  }
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 26) return result("image/bmp", "image");
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6) return result("image/x-icon", "image");
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return result("image/tiff", "image");
  }
  const ftyp = sniffFtyp(bytes);
  if (ftyp) return ftyp;
  if (ascii(bytes, 0, 5) === "%PDF-") return result("application/pdf", "pdf");
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return result("application/zip", "zip");
  }
  if (startsWith(bytes, [0x1f, 0x8b, 0x08])) return result("application/gzip", "gzip");
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return result("video/webm", "webm");
  if (ascii(bytes, 0, 4) === "OggS") return result("audio/ogg", "ogg");
  if (ascii(bytes, 0, 3) === "ID3") return result("audio/mpeg", "mp3");
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) {
    return result("audio/mpeg", "mp3");
  }
  if (ascii(bytes, 0, 3) === "CWS" || ascii(bytes, 0, 3) === "FWS" || ascii(bytes, 0, 3) === "ZWS") {
    return result("application/x-shockwave-flash", "active");
  }

  const markup = sniffMarkup(bytes);
  if (markup) return markup;

  return sniffText(bytes, complete) ?? result("application/octet-stream", "binary", false);
};

const declaredFamily = (declared: string): SniffFamily | null => {
  if (MAGIC_DECLARED[declared]) return MAGIC_DECLARED[declared];
  if (ZIP_CONTAINER_TYPES.some((prefix) => declared.startsWith(prefix))) return "zip";
  return null;
};

const isTextual = (type: string): boolean =>
  type.startsWith("text/") ||
  type === "application/json" ||
  type.endsWith("+json") ||
  type === "application/x-ndjson" ||
  type === "application/csv" ||
  type === "application/yaml" ||
  type === "application/x-yaml" ||
  type === "application/toml";

const compatible = (declared: string, sniffed: SniffResult): boolean => {
  const canonical = IMAGE_ALIASES[declared] ?? declared;
  if (canonical === sniffed.mimeType) return true;
  const family = declaredFamily(declared);
  if (!family) return false;
  if (family !== sniffed.family) return false;
  return family !== "image";
};

export interface ResolveContentTypeInput {
  declared?: string | null;
  bytes: Uint8Array;
  complete?: boolean;
  policy?: ContentSniffingPolicy;
}

export const resolveContentType = (input: ResolveContentTypeInput): ContentTypeDecision => {
  const policy = input.policy ?? "enforce";
  const declared = normalizeContentType(input.declared);
  const declaredOrNull = declared === "" ? null : declared;

  if (policy === "trust-declared") {
    return {
      mimeType: declared || "application/octet-stream",
      sniffed: null,
      declared: declaredOrNull,
      rejected: false,
    };
  }

  const sniffed = sniffContentType(input.bytes, { complete: input.complete });
  const enforce = policy === "enforce";
  const decision = (
    mimeType: string,
    reason?: ContentTypeDecision["reason"]
  ): ContentTypeDecision => ({
    mimeType,
    sniffed,
    declared: declaredOrNull,
    rejected: enforce && reason !== undefined,
    reason,
  });

  if (sniffed.active) {
    if (declared === sniffed.mimeType || GENERIC_TYPES.has(declared)) return decision(sniffed.mimeType);
    if (sniffed.mimeType === "image/svg+xml" && declared === "application/xml") return decision(sniffed.mimeType);
    if (sniffed.mimeType === "application/xml" && (declared === "text/xml" || isActiveContentType(declared))) {
      return decision(declared);
    }
    return decision(sniffed.mimeType, "active_content_mismatch");
  }

  if (sniffed.magic) {
    if (sniffed.family !== "zip" && sniffed.family !== "gzip" && containsActiveMarkup(input.bytes)) {
      return decision(sniffed.mimeType, "polyglot");
    }
    if (GENERIC_TYPES.has(declared)) return decision(sniffed.mimeType);
    if (compatible(declared, sniffed)) {
      return decision(sniffed.family === "image" ? sniffed.mimeType : declared);
    }
    if (declaredFamily(declared) || isActiveContentType(declared)) {
      return decision(sniffed.mimeType, "signature_mismatch");
    }
    return decision(sniffed.mimeType);
  }

  if (declaredFamily(declared)) {
    return decision(declared, "signature_mismatch");
  }
  if (isActiveContentType(declared)) {
    return decision(sniffed.family === "text" ? "text/plain" : "application/octet-stream");
  }
  if (sniffed.family === "text") {
    if (declared && isTextual(declared)) return decision(declared);
    if (GENERIC_TYPES.has(declared)) return decision(sniffed.mimeType);
    return decision(declared);
  }
  if (sniffed.family === "empty") return decision(declared || "application/octet-stream");
  return decision(declared || "application/octet-stream");
};

export const contentMismatchMessage = (decision: ContentTypeDecision): string => {
  const declared = decision.declared ?? "unspecified";
  const detected = decision.sniffed?.mimeType ?? "unknown";
  if (decision.reason === "polyglot") {
    return `File content contains embedded markup/script and was rejected (detected ${detected})`;
  }
  return `File content does not match its declared type (declared ${declared}, detected ${detected})`;
};
