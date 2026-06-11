import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordHashOptions {
  N?: number;
  r?: number;
  p?: number;
  keylen?: number;
  saltlen?: number;
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const DEFAULTS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltlen: 16,
} as const;

const ALGORITHM = "scrypt";

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(
  password: string,
  options?: PasswordHashOptions,
): Promise<string> {
  const N = options?.N ?? DEFAULTS.N;
  const r = options?.r ?? DEFAULTS.r;
  const p = options?.p ?? DEFAULTS.p;
  const keylen = options?.keylen ?? DEFAULTS.keylen;
  const saltlen = options?.saltlen ?? DEFAULTS.saltlen;

  const salt = randomBytes(saltlen);
  const hash = await deriveKey(password, salt, { N, r, p }, keylen);

  return `${ALGORITHM}$N=${N},r=${r},p=${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

interface ParsedHash {
  algorithm: string;
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parseStored(stored: string): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 4) return null;

  const [algorithm, paramStr, saltB64, hashB64] = parts;
  if (algorithm !== ALGORITHM) return null;

  const params = parseParams(paramStr);
  if (!params) return null;

  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    hash = Buffer.from(hashB64, "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length === 0) return null;

  return { algorithm, params, salt, hash };
}

function parseParams(paramStr: string): ScryptParams | null {
  const out: Partial<ScryptParams> = {};
  for (const segment of paramStr.split(",")) {
    const [key, value] = segment.split("=");
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) return null;
    if (key === "N") out.N = num;
    else if (key === "r") out.r = num;
    else if (key === "p") out.p = num;
    else return null;
  }
  if (out.N === undefined || out.r === undefined || out.p === undefined) return null;
  return { N: out.N, r: out.r, p: out.p };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;

  try {
    const candidate = await deriveKey(
      password,
      parsed.salt,
      parsed.params,
      parsed.hash.length,
    );
    if (candidate.length !== parsed.hash.length) return false;
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

export function needsRehash(stored: string, options?: PasswordHashOptions): boolean {
  const parsed = parseStored(stored);
  if (!parsed) return true;

  const targetN = options?.N ?? DEFAULTS.N;
  const targetR = options?.r ?? DEFAULTS.r;
  const targetP = options?.p ?? DEFAULTS.p;

  return parsed.params.N < targetN || parsed.params.r < targetR || parsed.params.p < targetP;
}
