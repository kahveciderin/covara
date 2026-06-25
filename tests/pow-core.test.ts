import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  sha256Hex,
  sha256Bytes,
  base64UrlEncode,
  base64UrlDecode,
  base64UrlEncodeBytes,
  base64UrlDecodeBytes,
  leadingZeroBits,
  solveChallenge,
  meetsDifficulty,
  encodeChallengePayload,
  decodeChallengePayload,
  utf8Bytes,
  type ChallengePayload,
} from "../src/pow/core";

const nodeSha = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

describe("pow/core sha256", () => {
  it("matches node:crypto for known vectors", () => {
    expect(sha256Hex("")).toBe(nodeSha(""));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe(
      nodeSha("The quick brown fox jumps over the lazy dog")
    );
  });

  it("matches node:crypto across many block boundaries (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(sha256Hex(s)).toBe(nodeSha(s));
      })
    );
  });

  it("hashes exactly at the 55/56/64 byte padding edges", () => {
    for (const len of [54, 55, 56, 57, 63, 64, 65, 119, 120]) {
      const s = "x".repeat(len);
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it("accepts raw byte input", () => {
    const bytes = utf8Bytes("abc");
    expect(sha256Bytes(bytes)).toEqual(sha256Bytes(utf8Bytes("abc")));
  });
});

describe("pow/core base64url", () => {
  it("roundtrips arbitrary strings (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(base64UrlDecode(base64UrlEncode(s))).toBe(s);
      })
    );
  });

  it("roundtrips arbitrary bytes (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (arr) => {
        expect(Array.from(base64UrlDecodeBytes(base64UrlEncodeBytes(arr)))).toEqual(
          Array.from(arr)
        );
      })
    );
  });

  it("produces url-safe output (no +/= )", () => {
    const encoded = base64UrlEncode("???>>><<<ÿþ");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("throws on invalid characters", () => {
    expect(() => base64UrlDecodeBytes("not valid!")).toThrow();
  });
});

describe("pow/core leadingZeroBits", () => {
  it("counts MSB-first zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x7f]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x0f]))).toBe(4);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x80]))).toBe(8);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x01]))).toBe(15);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00]))).toBe(16);
  });
});

describe("pow/core solveChallenge", () => {
  it("difficulty 0 resolves immediately without work", () => {
    expect(solveChallenge("token", 0)).toBe("0");
  });

  it("solves modest difficulties and the solution verifies", () => {
    for (const difficulty of [1, 4, 8, 12]) {
      const token = `challenge-${difficulty}`;
      const nonce = solveChallenge(token, difficulty);
      expect(meetsDifficulty(token, nonce, difficulty)).toBe(true);
      // and is genuinely below the next bit down where it would not be trivially satisfied
      expect(leadingZeroBits(sha256Bytes(utf8Bytes(`${token}:${nonce}`)))).toBeGreaterThanOrEqual(
        difficulty
      );
    }
  });

  it("a wrong nonce does not satisfy difficulty", () => {
    const token = "abc";
    const nonce = solveChallenge(token, 10);
    expect(meetsDifficulty(token, String(Number(nonce) + 1), 10)).toBe(false);
  });

  it("throws when maxIterations is exhausted", () => {
    expect(() => solveChallenge("hard", 32, { maxIterations: 100 })).toThrow();
  });

  it("rejects unsupported algorithms", () => {
    expect(() => meetsDifficulty("t", "0", 1, "md5" as never)).toThrow();
  });
});

describe("pow/core challenge payload", () => {
  const payload: ChallengePayload = {
    v: 1,
    d: 18,
    fp: "deadbeef",
    iat: 1000,
    exp: 2000,
    n: "abc123",
    alg: "sha256",
  };

  it("roundtrips", () => {
    expect(decodeChallengePayload(encodeChallengePayload(payload))).toEqual(payload);
  });

  it("rejects a malformed payload", () => {
    expect(() => decodeChallengePayload(base64UrlEncode(JSON.stringify({ foo: 1 })))).toThrow();
  });
});
