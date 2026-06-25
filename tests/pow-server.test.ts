import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  issueChallenge,
  verifySolution,
  computeFingerprint,
  consumeNonce,
  resolvePowSecret,
  resetPowSecretForTests,
  clearReplayCacheForTests,
} from "../src/pow/server";
import { solveChallenge, decodeChallengePayload } from "../src/pow/core";
import { setGlobalKV, clearGlobalKV, MemoryKVStore } from "../src/kv";

const SECRET = "test-secret-please-ignore";

const solveFor = (token: string, difficulty: number) => solveChallenge(token, difficulty);

describe("pow/server fingerprint", () => {
  it("is stable for identical requests and differs across requests", () => {
    const a = computeFingerprint("POST", "/api/todos", '{"title":"x"}');
    const b = computeFingerprint("POST", "/api/todos", '{"title":"x"}');
    const c = computeFingerprint("POST", "/api/todos", '{"title":"y"}');
    const d = computeFingerprint("GET", "/api/todos", "");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("pow/server issue + verify", () => {
  const fp = computeFingerprint("POST", "/api/todos", "{}");

  it("accepts a correctly solved challenge", () => {
    const { token, difficulty } = issueChallenge({ secret: SECRET, difficulty: 8, fingerprint: fp });
    const nonce = solveFor(token, difficulty);
    const result = verifySolution({ secret: SECRET, token, nonce, fingerprint: fp });
    expect(result.ok).toBe(true);
    expect(result.payload?.fp).toBe(fp);
  });

  it("rejects a missing solution", () => {
    expect(verifySolution({ secret: SECRET, token: null, nonce: null, fingerprint: fp }).reason).toBe(
      "missing"
    );
  });

  it("rejects a tampered signature (timing-safe)", () => {
    const { token, difficulty } = issueChallenge({ secret: SECRET, difficulty: 4, fingerprint: fp });
    const nonce = solveFor(token, difficulty);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifySolution({ secret: SECRET, token: tampered, nonce, fingerprint: fp }).reason).toBe(
      "bad_signature"
    );
  });

  it("rejects a different secret", () => {
    const { token, difficulty } = issueChallenge({ secret: SECRET, difficulty: 4, fingerprint: fp });
    const nonce = solveFor(token, difficulty);
    expect(verifySolution({ secret: "other", token, nonce, fingerprint: fp }).reason).toBe(
      "bad_signature"
    );
  });

  it("rejects an expired challenge", () => {
    const now = 1_000_000;
    const { token, difficulty } = issueChallenge({
      secret: SECRET,
      difficulty: 4,
      fingerprint: fp,
      ttlMs: 1000,
      now,
    });
    const nonce = solveFor(token, difficulty);
    expect(
      verifySolution({ secret: SECRET, token, nonce, fingerprint: fp, now: now + 2000 }).reason
    ).toBe("expired");
  });

  it("rejects a solution bound to a different request", () => {
    const { token, difficulty } = issueChallenge({ secret: SECRET, difficulty: 4, fingerprint: fp });
    const nonce = solveFor(token, difficulty);
    const otherFp = computeFingerprint("POST", "/api/todos", '{"x":1}');
    expect(verifySolution({ secret: SECRET, token, nonce, fingerprint: otherFp }).reason).toBe(
      "fingerprint_mismatch"
    );
  });

  it("rejects an insufficient-difficulty nonce", () => {
    const { token } = issueChallenge({ secret: SECRET, difficulty: 16, fingerprint: fp });
    // "0" is overwhelmingly unlikely to have 16 leading zero bits
    expect(verifySolution({ secret: SECRET, token, nonce: "0", fingerprint: fp }).reason).toBe(
      "insufficient_difficulty"
    );
  });

  it("rejects a malformed token", () => {
    expect(verifySolution({ secret: SECRET, token: "garbage", nonce: "0", fingerprint: fp }).reason).toBe(
      "malformed"
    );
  });

  it("embeds difficulty and expiry in the token payload", () => {
    const now = 5000;
    const { token } = issueChallenge({ secret: SECRET, difficulty: 12, fingerprint: fp, ttlMs: 3000, now });
    const payload = decodeChallengePayload(token.split(".")[0]);
    expect(payload.d).toBe(12);
    expect(payload.exp).toBe(8000);
  });
});

describe("pow/server replay cache", () => {
  describe("memory fallback (no KV)", () => {
    beforeEach(() => {
      clearGlobalKV();
      clearReplayCacheForTests();
    });
    afterEach(() => clearReplayCacheForTests());

    it("allows first use and rejects replay", async () => {
      const exp = Date.now() + 60_000;
      expect(await consumeNonce("nonce-1", exp)).toBe(true);
      expect(await consumeNonce("nonce-1", exp)).toBe(false);
      expect(await consumeNonce("nonce-2", exp)).toBe(true);
    });

    it("allows reuse once the TTL window has passed", async () => {
      const now = 1_000_000;
      expect(await consumeNonce("expiring", now + 1000, undefined, now)).toBe(true);
      expect(await consumeNonce("expiring", now + 1000, undefined, now + 2000)).toBe(true);
    });
  });

  describe("KV-backed", () => {
    let kv: MemoryKVStore;
    beforeEach(async () => {
      kv = new MemoryKVStore();
      await kv.connect();
      setGlobalKV(kv);
    });
    afterEach(() => {
      clearGlobalKV();
      clearReplayCacheForTests();
    });

    it("allows first use and rejects replay via the global KV", async () => {
      const exp = Date.now() + 60_000;
      expect(await consumeNonce("kv-nonce", exp)).toBe(true);
      expect(await consumeNonce("kv-nonce", exp)).toBe(false);
    });
  });
});

describe("pow/server secret resolution", () => {
  const original = process.env.COVARA_POW_SECRET;
  beforeEach(() => resetPowSecretForTests());
  afterEach(() => {
    if (original === undefined) delete process.env.COVARA_POW_SECRET;
    else process.env.COVARA_POW_SECRET = original;
    resetPowSecretForTests();
  });

  it("prefers an explicit secret", () => {
    expect(resolvePowSecret("explicit")).toBe("explicit");
  });

  it("falls back to the env var", () => {
    process.env.COVARA_POW_SECRET = "from-env";
    expect(resolvePowSecret()).toBe("from-env");
  });

  it("generates a stable random secret per process when unset", () => {
    delete process.env.COVARA_POW_SECRET;
    const a = resolvePowSecret();
    const b = resolvePowSecret();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});
