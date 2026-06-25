/**
 * Isomorphic proof-of-work primitives.
 *
 * This module has ZERO Node.js dependencies so it can be bundled into the
 * browser client. It provides a synchronous SHA-256, base64url codecs, the
 * leading-zero-bit difficulty metric, the challenge payload encode/decode, and
 * the hashcash-style solver shared by client and server.
 */

export type PowAlgorithm = "sha256";

export interface ChallengePayload {
  v: number;
  d: number;
  fp: string;
  iat: number;
  exp: number;
  n: string;
  alg: PowAlgorithm;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * Synchronous SHA-256 over raw bytes, returning the 32-byte digest.
 */
export const sha256Bytes = (message: Uint8Array): Uint8Array => {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = message.length * 8;
  const withOne = message.length + 1;
  const totalLen = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, h[i], false);
  }
  return out;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Bytes = (input: string): Uint8Array => encoder.encode(input);

const HEX = "0123456789abcdef";

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >>> 4] + HEX[bytes[i] & 0xf];
  }
  return out;
};

export const sha256Hex = (input: string | Uint8Array): string =>
  bytesToHex(sha256Bytes(typeof input === "string" ? utf8Bytes(input) : input));

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) {
    table[B64URL.charCodeAt(i)] = i;
  }
  return table;
})();

export const base64UrlEncodeBytes = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63];
  }
  return out;
};

export const base64UrlDecodeBytes = (input: string): Uint8Array => {
  const len = input.length;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? B64URL_LOOKUP[code] : -1;
    if (value === -1) {
      throw new Error("Invalid base64url character");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
};

export const base64UrlEncode = (input: string): string =>
  base64UrlEncodeBytes(utf8Bytes(input));

export const base64UrlDecode = (input: string): string =>
  decoder.decode(base64UrlDecodeBytes(input));

const CLZ8 = (byte: number): number => {
  if (byte === 0) return 8;
  let n = 0;
  for (let mask = 0x80; mask > 0; mask >>= 1) {
    if (byte & mask) break;
    n++;
  }
  return n;
};

/**
 * Count the number of leading zero bits in a byte array (most significant bit
 * of byte 0 first).
 */
export const leadingZeroBits = (bytes: Uint8Array): number => {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const z = CLZ8(bytes[i]);
    count += z;
    if (z !== 8) break;
  }
  return count;
};

export const encodeChallengePayload = (payload: ChallengePayload): string =>
  base64UrlEncode(JSON.stringify(payload));

export const decodeChallengePayload = (encoded: string): ChallengePayload => {
  const parsed = JSON.parse(base64UrlDecode(encoded)) as ChallengePayload;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.d !== "number" ||
    typeof parsed.fp !== "string" ||
    typeof parsed.exp !== "number" ||
    typeof parsed.n !== "string"
  ) {
    throw new Error("Malformed challenge payload");
  }
  return parsed;
};

/**
 * Hash that the solver must drive below the difficulty target. The full
 * challenge token (payload.signature) is concatenated with the candidate nonce
 * so a solution is bound to the exact issued challenge.
 */
export const solutionDigest = (
  token: string,
  nonce: string,
  algorithm: PowAlgorithm = "sha256"
): Uint8Array => {
  if (algorithm !== "sha256") {
    throw new Error(`Unsupported proof-of-work algorithm: ${algorithm}`);
  }
  return sha256Bytes(utf8Bytes(`${token}:${nonce}`));
};

export const meetsDifficulty = (
  token: string,
  nonce: string,
  difficulty: number,
  algorithm: PowAlgorithm = "sha256"
): boolean => leadingZeroBits(solutionDigest(token, nonce, algorithm)) >= difficulty;

export interface SolveOptions {
  algorithm?: PowAlgorithm;
  maxIterations?: number;
}

/**
 * Find a nonce whose `solutionDigest` has at least `difficulty` leading zero
 * bits. Returns the nonce as a decimal string. Difficulty 0 resolves
 * immediately. Throws if `maxIterations` is exhausted (a safety valve against
 * an unreasonable difficulty).
 */
export const solveChallenge = (
  token: string,
  difficulty: number,
  options: SolveOptions = {}
): string => {
  const algorithm = options.algorithm ?? "sha256";
  const maxIterations = options.maxIterations ?? 1e8;
  if (difficulty <= 0) {
    return "0";
  }
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const candidate = String(nonce);
    if (meetsDifficulty(token, candidate, difficulty, algorithm)) {
      return candidate;
    }
  }
  throw new Error(
    `Proof-of-work not solved within ${maxIterations} iterations (difficulty ${difficulty})`
  );
};
