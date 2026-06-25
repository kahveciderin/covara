/**
 * Server-side proof-of-work: stateless signed challenge issuance + verification
 * plus a short-TTL replay cache. Challenge verification is cryptographically
 * stateless (HMAC); only one-time-use enforcement touches the (KV or memory)
 * replay cache.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { KVAdapter } from "@/kv";
import { getGlobalKV, hasGlobalKV } from "@/kv";
import { getLogger } from "@/server/logger";
import { readEnv } from "@/server/env";
import {
  base64UrlEncodeBytes,
  decodeChallengePayload,
  encodeChallengePayload,
  meetsDifficulty,
  sha256Hex,
  utf8Bytes,
  type ChallengePayload,
  type PowAlgorithm,
} from "./core";

export const POW_HEADER = {
  challenge: "Covara-PoW-Challenge",
  difficulty: "Covara-PoW-Difficulty",
  algorithm: "Covara-PoW-Algorithm",
  nonce: "Covara-PoW-Nonce",
} as const;

const CHALLENGE_VERSION = 1;
const REPLAY_PREFIX = "covara:pow:used:";
const DEFAULT_TTL_MS = 120_000;

let resolvedSecret: string | null = null;

/**
 * Resolve the HMAC secret: explicit config -> COVARA_POW_SECRET env -> a random
 * dev-only secret (warns; a random per-process secret breaks verification
 * across processes, so production must set one explicitly).
 */
export const resolvePowSecret = (configured?: string): string => {
  if (configured) return configured;
  const fromEnv = readEnv("COVARA_POW_SECRET");
  if (fromEnv) return fromEnv;
  if (!resolvedSecret) {
    resolvedSecret = randomBytes(32).toString("hex");
    getLogger().warn(
      "Proof-of-work secret not configured; generated a random per-process secret. " +
        "Set COVARA_POW_SECRET (or abuseProtection.pow.secret) so challenges verify across processes/restarts."
    );
  }
  return resolvedSecret;
};

export const resetPowSecretForTests = (): void => {
  resolvedSecret = null;
};

/**
 * Bind a challenge to the exact request: method + path(+query) + a hash of the
 * raw body. The client re-sends the identical request, so the fingerprint
 * recomputes to the same value on the retry.
 */
export const computeFingerprint = (
  method: string,
  pathWithQuery: string,
  bodyText = ""
): string =>
  sha256Hex(`${method.toUpperCase()}\n${pathWithQuery}\n${sha256Hex(bodyText)}`);

const sign = (secret: string, payloadEncoded: string): string =>
  base64UrlEncodeBytes(
    new Uint8Array(createHmac("sha256", secret).update(payloadEncoded).digest())
  );

export interface IssueChallengeOptions {
  secret: string;
  difficulty: number;
  fingerprint: string;
  ttlMs?: number;
  algorithm?: PowAlgorithm;
  now?: number;
  nonce?: string;
}

export interface IssuedChallenge {
  token: string;
  difficulty: number;
  algorithm: PowAlgorithm;
  expiresAt: number;
}

export const issueChallenge = (options: IssueChallengeOptions): IssuedChallenge => {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const algorithm = options.algorithm ?? "sha256";
  const payload: ChallengePayload = {
    v: CHALLENGE_VERSION,
    d: options.difficulty,
    fp: options.fingerprint,
    iat: now,
    exp: now + ttlMs,
    n: options.nonce ?? randomBytes(16).toString("hex"),
    alg: algorithm,
  };
  const encoded = encodeChallengePayload(payload);
  const token = `${encoded}.${sign(options.secret, encoded)}`;
  return { token, difficulty: options.difficulty, algorithm, expiresAt: payload.exp };
};

export type VerifyFailure =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "fingerprint_mismatch"
  | "insufficient_difficulty"
  | "replayed";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  payload?: ChallengePayload;
}

export interface VerifySolutionOptions {
  secret: string;
  token: string | undefined | null;
  nonce: string | undefined | null;
  fingerprint: string;
  now?: number;
}

/**
 * Stateless verification of a submitted solution. Does NOT consult the replay
 * cache — call `consumeNonce` separately once verification passes so a failed
 * verification never burns a nonce.
 */
export const verifySolution = (options: VerifySolutionOptions): VerifyResult => {
  const { secret, token, nonce, fingerprint } = options;
  const now = options.now ?? Date.now();

  if (!token || !nonce) return { ok: false, reason: "missing" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const encoded = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payload: ChallengePayload;
  try {
    payload = decodeChallengePayload(encoded);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const expectedSig = sign(secret, encoded);
  const a = utf8Bytes(providedSig);
  const b = utf8Bytes(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.fp !== fingerprint) return { ok: false, reason: "fingerprint_mismatch" };
  if (!meetsDifficulty(token, nonce, payload.d, payload.alg)) {
    return { ok: false, reason: "insufficient_difficulty" };
  }

  return { ok: true, payload };
};

interface MemoryEntry {
  expiresAt: number;
}

const memoryReplay = new Map<string, MemoryEntry>();
let memoryCleanup: ReturnType<typeof setInterval> | null = null;

const ensureMemoryCleanup = (): void => {
  if (memoryCleanup) return;
  memoryCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryReplay) {
      if (entry.expiresAt <= now) memoryReplay.delete(key);
    }
  }, 60_000);
  if (typeof memoryCleanup === "object" && "unref" in memoryCleanup) {
    memoryCleanup.unref();
  }
};

/**
 * Atomically record a nonce as consumed. Returns true when the nonce is fresh
 * (first use) and false when it has already been used within its TTL window.
 * Uses an atomic INCR on the global KV (or an injected store); falls back to an
 * in-process map when no KV is configured.
 */
export const consumeNonce = async (
  nonce: string,
  expiresAt: number,
  store?: KVAdapter,
  now = Date.now()
): Promise<boolean> => {
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const kv = store ?? (hasGlobalKV() ? getGlobalKV() : null);

  if (!kv) {
    ensureMemoryCleanup();
    const existing = memoryReplay.get(nonce);
    if (existing && existing.expiresAt > now) return false;
    memoryReplay.set(nonce, { expiresAt });
    return true;
  }

  const key = `${REPLAY_PREFIX}${nonce}`;
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, ttlSeconds);
    return true;
  }
  return false;
};

export const clearReplayCacheForTests = (): void => {
  memoryReplay.clear();
  if (memoryCleanup) {
    clearInterval(memoryCleanup);
    memoryCleanup = null;
  }
};
