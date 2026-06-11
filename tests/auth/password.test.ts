import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, needsRehash } from "@/auth/password";

const FAST = { N: 1024, r: 8, p: 1 } as const;

describe("password hashing", () => {
  it("produces a different output each time for the same password (random salt)", async () => {
    const a = await hashPassword("hunter2", FAST);
    const b = await hashPassword("hunter2", FAST);
    expect(a).not.toBe(b);
  });

  it("encodes algorithm and params in a self-describing format", async () => {
    const stored = await hashPassword("hunter2", FAST);
    const parts = stored.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("N=1024,r=8,p=1");
  });

  it("verifies the correct password", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("hashes and verifies an empty password", async () => {
    const stored = await hashPassword("", FAST);
    expect(await verifyPassword("", stored)).toBe(true);
    expect(await verifyPassword("x", stored)).toBe(false);
  });

  describe("malformed / hostile input returns false without throwing", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["no delimiters", "garbage"],
      ["too few parts", "scrypt$N=1024,r=8,p=1$salt"],
      ["too many parts", "scrypt$N=1024,r=8,p=1$salt$hash$extra"],
      ["unknown algorithm", "bcrypt$N=1024,r=8,p=1$c2FsdA==$aGFzaA=="],
      ["missing params", "scrypt$N=1024,r=8$c2FsdA==$aGFzaA=="],
      ["non-numeric param", "scrypt$N=abc,r=8,p=1$c2FsdA==$aGFzaA=="],
      ["empty salt", "scrypt$N=1024,r=8,p=1$$aGFzaA=="],
    ];
    for (const [name, value] of cases) {
      it(name, async () => {
        await expect(verifyPassword("anything", value)).resolves.toBe(false);
      });
    }
  });

  it("does not throw when the stored hash length differs (timing-safe path)", async () => {
    const stored = "scrypt$N=1024,r=8,p=1$c2FsdHNhbHQ=$YQ==";
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("uses constant-time comparison and verifies a real round trip", async () => {
    const stored = await hashPassword("a-real-password", FAST);
    expect(await verifyPassword("a-real-password", stored)).toBe(true);
  });

  it("round-trips unicode passwords", async () => {
    const pw = "пароль🔐密码—naïve";
    const stored = await hashPassword(pw, FAST);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword("password", stored)).toBe(false);
  });

  it("round-trips very long passwords", async () => {
    const pw = "x".repeat(4096);
    const stored = await hashPassword(pw, FAST);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword("x".repeat(4095), stored)).toBe(false);
  });
});

describe("needsRehash", () => {
  it("returns true when stored params are weaker than target", async () => {
    const stored = await hashPassword("pw", { N: 1024, r: 8, p: 1 });
    expect(needsRehash(stored, { N: 16384, r: 8, p: 1 })).toBe(true);
  });

  it("returns false when stored params equal target", async () => {
    const stored = await hashPassword("pw", { N: 1024, r: 8, p: 1 });
    expect(needsRehash(stored, { N: 1024, r: 8, p: 1 })).toBe(false);
  });

  it("returns false when stored params are stronger than target", async () => {
    const stored = await hashPassword("pw", { N: 2048, r: 16, p: 2 });
    expect(needsRehash(stored, { N: 1024, r: 8, p: 1 })).toBe(false);
  });

  it("detects a weaker single dimension (r)", async () => {
    const stored = await hashPassword("pw", { N: 1024, r: 4, p: 1 });
    expect(needsRehash(stored, { N: 1024, r: 8, p: 1 })).toBe(true);
  });

  it("returns true for malformed stored strings", () => {
    expect(needsRehash("garbage")).toBe(true);
    expect(needsRehash("")).toBe(true);
  });
});
