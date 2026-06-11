import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { useAuth, AuthUser, MfaEnrollment } from "@/auth/routes";
import { createPassportAdapter, PassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore } from "@/auth/types";
import { InMemoryVerificationTokenStore } from "@/auth/verification";
import {
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  getTotpUri,
  generateBackupCodes,
  verifyBackupCode,
  base32Decode,
  base32Encode,
} from "@/auth/totp";
import {
  createApiKey,
  verifyApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  InMemoryApiKeyStore,
} from "@/auth/api-keys";
import { validatePasswordStrength } from "@/auth/password-policy";
import { createTestApp, get, post } from "../helpers/hono";

const STEP = 30;

describe("TOTP", () => {
  it("round-trips base32 encode/decode", () => {
    const buf = Buffer.from("hello totp world");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("generates a base32 secret and an otpauth URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const uri = getTotpUri({ secret, account: "user@example.com", issuer: "Concave" });
    expect(uri).toContain("otpauth://totp/Concave:user%40example.com");
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=Concave");
  });

  it("verifies a freshly generated token", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const token = generateTotp(secret, { timestampMs: now });
    expect(verifyTotp(secret, token, { timestampMs: now })).toBe(true);
  });

  it("accepts a token within the drift window", () => {
    const secret = generateTotpSecret();
    const base = 1_000_000_000_000;
    const prevToken = generateTotp(secret, { timestampMs: base - STEP * 1000 });
    const nextToken = generateTotp(secret, { timestampMs: base + STEP * 1000 });
    expect(verifyTotp(secret, prevToken, { timestampMs: base, window: 1 })).toBe(true);
    expect(verifyTotp(secret, nextToken, { timestampMs: base, window: 1 })).toBe(true);
  });

  it("rejects a token outside the drift window", () => {
    const secret = generateTotpSecret();
    const base = 1_000_000_000_000;
    const farToken = generateTotp(secret, { timestampMs: base + STEP * 1000 * 5 });
    expect(verifyTotp(secret, farToken, { timestampMs: base, window: 1 })).toBe(false);
  });

  it("rejects a wrong token", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "000000", { timestampMs: Date.now() })).toBe(false);
    expect(verifyTotp(secret, "abc", { timestampMs: Date.now() })).toBe(false);
  });

  it("supports single-use backup codes", async () => {
    const { codes, hashes } = await generateBackupCodes(5);
    expect(codes).toHaveLength(5);
    const first = await verifyBackupCode(codes[0], hashes);
    expect(first.matched).toBe(true);
    expect(first.index).toBe(0);

    const remaining = hashes.filter((_, i) => i !== first.index);
    const reused = await verifyBackupCode(codes[0], remaining);
    expect(reused.matched).toBe(false);

    const wrong = await verifyBackupCode("zzzzz-zzzzz", hashes);
    expect(wrong.matched).toBe(false);
  });
});

describe("MFA login gating routes", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let users: Map<string, AuthUser & { passwordHash: string; mfa?: MfaEnrollment | null }>;

  const buildAuth = () => {
    const { router, middleware } = useAuth({
      adapter: authAdapter,
      mfa: {
        issuer: "Concave",
        requireOnLogin: true,
        getUserByEmail: async (email) => {
          for (const u of users.values()) {
            if (u.email === email) return { id: u.id, email: u.email, name: u.name, mfa: u.mfa };
          }
          return null;
        },
        getEnrollment: async (userId) => users.get(userId)?.mfa ?? null,
        saveEnrollment: async (userId, enrollment) => {
          const u = users.get(userId);
          if (u) u.mfa = enrollment;
        },
        consumeBackupCode: async (userId, index) => {
          const u = users.get(userId);
          if (u?.mfa?.backupCodeHashes) {
            u.mfa.backupCodeHashes = u.mfa.backupCodeHashes.filter((_, i) => i !== index);
          }
        },
      },
      login: {
        validateCredentials: async (email, password) => {
          for (const u of users.values()) {
            if (u.email === email && u.passwordHash === password) {
              return { id: u.id, email: u.email, name: u.name };
            }
          }
          return null;
        },
      },
    });
    app.route("/api/auth", router);
    app.use("*", middleware);
  };

  beforeEach(() => {
    app = createTestApp();
    sessionStore = new InMemorySessionStore();
    users = new Map();
    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const u = users.get(id);
        return u ? { id: u.id, email: u.email, name: u.name, image: null } : null;
      },
      sessionStore,
    });
  });

  it("enrolls, confirms, then gates login on a TOTP code", async () => {
    users.set("u1", { id: "u1", email: "mfa@example.com", name: "M", passwordHash: "secret" });
    buildAuth();

    const session = await authAdapter.createSession("u1");
    const cookie = `session=${session.id}`;

    const enroll = await post(app, "/api/auth/mfa/enroll", {}, { cookie });
    expect(enroll.status).toBe(200);
    const secret = enroll.body.secret as string;
    expect(enroll.body.otpauthUri).toContain("otpauth://");
    expect(enroll.body.backupCodes.length).toBeGreaterThan(0);

    expect(users.get("u1")!.mfa!.enabled).toBe(false);

    const code = generateTotp(secret);
    const confirm = await post(app, "/api/auth/mfa/enroll/confirm", { code }, { cookie });
    expect(confirm.status).toBe(200);
    expect(users.get("u1")!.mfa!.enabled).toBe(true);

    const noCode = await post(app, "/api/auth/login", {
      email: "mfa@example.com",
      password: "secret",
    });
    expect(noCode.status).toBe(401);
    expect(noCode.body.mfaRequired).toBe(true);

    const badCode = await post(app, "/api/auth/login", {
      email: "mfa@example.com",
      password: "secret",
      mfaCode: "000000",
    });
    expect(badCode.status).toBe(401);

    const goodCode = await post(app, "/api/auth/login", {
      email: "mfa@example.com",
      password: "secret",
      mfaCode: generateTotp(secret),
    });
    expect(goodCode.status).toBe(200);
    expect(goodCode.body.sessionId).toBeDefined();
  });

  it("allows login with a single-use backup code and rejects reuse", async () => {
    const { codes, hashes } = await generateBackupCodes(3);
    const secret = generateTotpSecret();
    users.set("u1", {
      id: "u1",
      email: "backup@example.com",
      name: "B",
      passwordHash: "secret",
      mfa: { secret, enabled: true, backupCodeHashes: hashes },
    });
    buildAuth();

    const first = await post(app, "/api/auth/login", {
      email: "backup@example.com",
      password: "secret",
      mfaCode: codes[0],
    });
    expect(first.status).toBe(200);

    const reuse = await post(app, "/api/auth/login", {
      email: "backup@example.com",
      password: "secret",
      mfaCode: codes[0],
    });
    expect(reuse.status).toBe(401);
  });

  it("does not gate users without MFA enabled", async () => {
    users.set("u1", { id: "u1", email: "nomfa@example.com", name: "N", passwordHash: "secret" });
    buildAuth();

    const res = await post(app, "/api/auth/login", {
      email: "nomfa@example.com",
      password: "secret",
    });
    expect(res.status).toBe(200);
  });
});

describe("Magic link", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let store: InMemoryVerificationTokenStore;
  let users: Map<string, AuthUser & { passwordHash: string }>;
  let sent: { identifier: string; token: string } | null;

  beforeEach(() => {
    app = createTestApp();
    sessionStore = new InMemorySessionStore();
    store = new InMemoryVerificationTokenStore();
    sent = null;
    users = new Map();
    users.set("u1", { id: "u1", email: "magic@example.com", name: "Mg", passwordHash: "x" });
    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const u = users.get(id);
        return u ? { id: u.id, email: u.email, name: u.name, image: null } : null;
      },
      sessionStore,
    });
    const { router } = useAuth({
      adapter: authAdapter,
      magicLink: {
        store,
        sendLink: async ({ identifier, token }) => {
          sent = { identifier, token };
        },
        findUserByEmail: async (email) => {
          for (const u of users.values()) {
            if (u.email === email) return { id: u.id, email: u.email, name: u.name };
          }
          return null;
        },
        ttlMs: 1000,
      },
    });
    app.route("/api/auth", router);
  });

  it("logs the user in via a magic link round-trip", async () => {
    const req = await post(app, "/api/auth/magic-link/request", { email: "magic@example.com" });
    expect(req.status).toBe(200);
    expect(sent).not.toBeNull();

    const verify = await post(app, "/api/auth/magic-link/verify", {
      email: "magic@example.com",
      token: sent!.token,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.sessionId).toBeDefined();
  });

  it("rejects a reused token", async () => {
    await post(app, "/api/auth/magic-link/request", { email: "magic@example.com" });
    const token = sent!.token;

    const first = await post(app, "/api/auth/magic-link/verify", {
      email: "magic@example.com",
      token,
    });
    expect(first.status).toBe(200);

    const second = await post(app, "/api/auth/magic-link/verify", {
      email: "magic@example.com",
      token,
    });
    expect(second.status).toBe(401);
  });

  it("responds identically for known and unknown emails", async () => {
    const known = await post(app, "/api/auth/magic-link/request", { email: "magic@example.com" });
    const knownSent = sent;
    sent = null;

    const unknown = await post(app, "/api/auth/magic-link/request", {
      email: "nobody@example.com",
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(knownSent).not.toBeNull();
    expect(sent).toBeNull();
  });
});

describe("API key lifecycle", () => {
  let store: InMemoryApiKeyStore;

  beforeEach(() => {
    store = new InMemoryApiKeyStore();
  });

  it("creates, verifies, rotates and revokes a key", async () => {
    const created = await createApiKey({ store, label: "ci", userId: "u1", prefix: "ck" });
    expect(created.key).toContain("ck_");
    expect(created.metadata.label).toBe("ci");

    const ok = await verifyApiKey(created.key, { store });
    expect(ok.valid).toBe(true);
    expect(ok.metadata?.userId).toBe("u1");

    const bad = await verifyApiKey("ck_deadbeef.nope", { store });
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe("not_found");

    const list = await listApiKeys({ store, userId: "u1" });
    expect(list).toHaveLength(1);

    const rotated = await rotateApiKey({ store, id: created.metadata.id });
    expect(rotated.key).not.toBe(created.key);
    expect(rotated.metadata.label).toBe("ci");
    expect(rotated.metadata.userId).toBe("u1");

    const oldVerify = await verifyApiKey(created.key, { store });
    expect(oldVerify.valid).toBe(false);
    const newVerify = await verifyApiKey(rotated.key, { store });
    expect(newVerify.valid).toBe(true);

    await revokeApiKey(rotated.metadata.id, { store });
    const afterRevoke = await verifyApiKey(rotated.key, { store });
    expect(afterRevoke.valid).toBe(false);
    expect(await listApiKeys({ store, userId: "u1" })).toHaveLength(0);
  });

  it("rejects an expired key", async () => {
    const created = await createApiKey({ store, ttlMs: 1000 });
    const future = new Date(Date.now() + 5000);
    const res = await verifyApiKey(created.key, { store, now: future });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("updates lastUsedAt on verify", async () => {
    const created = await createApiKey({ store });
    expect(created.metadata.lastUsedAt).toBeNull();

    const at = new Date(Date.now() + 1000);
    await verifyApiKey(created.key, { store, now: at });
    const stored = await store.findById(created.metadata.id);
    expect(stored?.lastUsedAt?.getTime()).toBe(at.getTime());

    const noUpdate = await createApiKey({ store });
    await verifyApiKey(noUpdate.key, { store, updateLastUsed: false });
    const storedNoUpdate = await store.findById(noUpdate.metadata.id);
    expect(storedNoUpdate?.lastUsedAt ?? null).toBeNull();
  });
});

describe("Password strength policy", () => {
  it("accepts a strong password", () => {
    const result = validatePasswordStrength("Str0ng!Passw0rd", {
      minLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a short password", () => {
    const result = validatePasswordStrength("aB1!", { minLength: 8 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least 8"))).toBe(true);
  });

  it("rejects missing character classes", () => {
    const result = validatePasswordStrength("alllowercase", {
      minLength: 4,
      requireUppercase: true,
      requireNumber: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a denylisted common password", () => {
    const result = validatePasswordStrength("password", { minLength: 4 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too common"))).toBe(true);
  });

  it("rejects a custom denylisted password case-insensitively", () => {
    const result = validatePasswordStrength("MyCompany123", {
      minLength: 4,
      useBuiltInDenylist: false,
      denylist: ["mycompany123"],
    });
    expect(result.valid).toBe(false);
  });
});

describe("Password policy wired into signup and reset", () => {
  let app: Hono;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let store: InMemoryVerificationTokenStore;
  let users: Map<string, AuthUser & { passwordHash: string }>;
  let sent: { token: string } | null;

  beforeEach(() => {
    app = createTestApp();
    sessionStore = new InMemorySessionStore();
    store = new InMemoryVerificationTokenStore();
    sent = null;
    users = new Map();
    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const u = users.get(id);
        return u ? { id: u.id, email: u.email, name: u.name, image: null } : null;
      },
      sessionStore,
    });
    const { router } = useAuth({
      adapter: authAdapter,
      passwordPolicy: { minLength: 10, requireNumber: true },
      signup: {
        createUser: async ({ email, password, name }) => {
          const id = `u${users.size + 1}`;
          users.set(id, { id, email, name, passwordHash: password });
          return { id, email, name };
        },
      },
      passwordReset: {
        store,
        sendToken: async ({ token }) => {
          sent = { token };
        },
        findUserByEmail: async (email) => {
          for (const u of users.values()) if (u.email === email) return { id: u.id };
          return null;
        },
        resetPassword: async (email, hash) => {
          for (const u of users.values()) if (u.email === email) u.passwordHash = hash;
        },
      },
    });
    app.route("/api/auth", router);
  });

  it("rejects a weak signup password", async () => {
    const res = await post(app, "/api/auth/signup", {
      email: "weak@example.com",
      password: "short1",
    });
    expect(res.status).toBe(400);
    expect(users.size).toBe(0);
  });

  it("accepts a strong signup password", async () => {
    const res = await post(app, "/api/auth/signup", {
      email: "strong@example.com",
      password: "longenough1",
    });
    expect(res.status).toBe(200);
    expect(users.size).toBe(1);
  });

  it("rejects a weak password during reset", async () => {
    users.set("u1", { id: "u1", email: "reset@example.com", name: "R", passwordHash: "x" });
    await post(app, "/api/auth/password/forgot", { email: "reset@example.com" });
    const res = await post(app, "/api/auth/password/reset", {
      email: "reset@example.com",
      token: sent!.token,
      password: "weak",
    });
    expect(res.status).toBe(400);
  });
});
