import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (buffer: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
};

export const base32Decode = (input: string): Buffer => {
  const cleaned = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error("Invalid base32 character");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

export interface TotpOptions {
  step?: number;
  digits?: number;
  window?: number;
}

const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;

export const generateTotpSecret = (byteLength = 20): string => {
  return base32Encode(randomBytes(byteLength));
};

const counterBuffer = (counter: number): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
};

const hotp = (secret: Buffer, counter: number, digits: number): string => {
  const hmac = createHmac("sha1", secret).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
};

export const generateTotp = (
  secret: string,
  options: TotpOptions & { timestampMs?: number } = {}
): string => {
  const step = options.step ?? DEFAULT_STEP;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const timestampMs = options.timestampMs ?? Date.now();
  const counter = Math.floor(timestampMs / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
};

export const verifyTotp = (
  secret: string,
  token: string,
  options: TotpOptions & { timestampMs?: number } = {}
): boolean => {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  const step = options.step ?? DEFAULT_STEP;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const window = options.window ?? 1;
  if (trimmed.length !== digits || !/^\d+$/.test(trimmed)) return false;

  const timestampMs = options.timestampMs ?? Date.now();
  const counter = Math.floor(timestampMs / 1000 / step);
  const secretBuffer = base32Decode(secret);
  const candidate = Buffer.from(trimmed);

  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(hotp(secretBuffer, counter + offset, digits));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return true;
    }
  }

  return false;
};

export interface TotpUriParams {
  secret: string;
  account: string;
  issuer?: string;
  digits?: number;
  step?: number;
}

export const getTotpUri = (params: TotpUriParams): string => {
  const digits = params.digits ?? DEFAULT_DIGITS;
  const step = params.step ?? DEFAULT_STEP;
  const label = params.issuer
    ? `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`
    : encodeURIComponent(params.account);

  const query = new URLSearchParams({
    secret: params.secret,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(step),
  });
  if (params.issuer) {
    query.set("issuer", params.issuer);
  }

  return `otpauth://totp/${label}?${query.toString()}`;
};

export interface BackupCodesResult {
  codes: string[];
  hashes: string[];
}

const formatBackupCode = (raw: Buffer): string => {
  const hex = raw.toString("hex").slice(0, 10);
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}`;
};

export const generateBackupCodes = async (count = 10): Promise<BackupCodesResult> => {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(formatBackupCode(randomBytes(5)));
  }
  const hashes = await Promise.all(codes.map((code) => hashPassword(code)));
  return { codes, hashes };
};

export const verifyBackupCode = async (
  code: string,
  hashes: string[]
): Promise<{ matched: boolean; index: number }> => {
  const normalized = code.trim();
  for (let i = 0; i < hashes.length; i++) {
    if (await verifyPassword(normalized, hashes[i])) {
      return { matched: true, index: i };
    }
  }
  return { matched: false, index: -1 };
};
