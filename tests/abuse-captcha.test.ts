import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono, type Context, type Next } from "hono";
import { createAbuseMiddleware } from "../src/abuse/middleware";
import { abuseProtection, clearGlobalAbuseProtection } from "../src/abuse/config";
import {
  turnstile,
  hcaptcha,
  recaptcha,
  customCaptcha,
} from "../src/abuse/captcha";
import { clearBudgetMemoryForTests } from "../src/abuse/budget";
import { clearReplayCacheForTests } from "../src/pow/server";
import { errorHandler } from "../src/middleware/error";
import { solveChallenge } from "../src/pow/core";
import { clearGlobalKV } from "../src/kv";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.COVARA_POW_SECRET = "captcha-test-secret";
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
  clearReplayCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.COVARA_POW_SECRET;
  clearGlobalAbuseProtection();
  vi.restoreAllMocks();
});

describe("captcha providers", () => {
  it("turnstile passes on success and fails otherwise", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true })) as never;
    expect(await turnstile({ secret: "s" }).verify("tok")).toBe(true);

    globalThis.fetch = vi.fn(async () => jsonResponse({ success: false })) as never;
    expect(await turnstile({ secret: "s" }).verify("tok")).toBe(false);
  });

  it("hcaptcha verifies success", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true })) as never;
    expect(await hcaptcha({ secret: "s" }).verify("tok")).toBe(true);
  });

  it("recaptcha enforces minScore and action", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true, score: 0.3, action: "login" })) as never;
    expect(await recaptcha({ secret: "s", minScore: 0.5 }).verify("tok")).toBe(false);

    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true, score: 0.9, action: "login" })) as never;
    expect(await recaptcha({ secret: "s", minScore: 0.5 }).verify("tok", { action: "login" })).toBe(true);
    expect(await recaptcha({ secret: "s", minScore: 0.5 }).verify("tok", { action: "signup" })).toBe(false);
  });

  it("fails closed on a network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as never;
    expect(await turnstile({ secret: "s" }).verify("tok")).toBe(false);
  });

  it("customCaptcha returns false when the verifier throws", async () => {
    const p = customCaptcha({
      verify: () => {
        throw new Error("boom");
      },
    });
    expect(await p.verify("tok")).toBe(false);
  });

  it("exposes the public site key", () => {
    expect(turnstile({ secret: "s", siteKey: "PUBLIC" }).siteKey).toBe("PUBLIC");
  });
});

// A controllable provider: the token "good" is valid, everything else invalid.
const stubProvider = (siteKey = "site-key") =>
  customCaptcha({ name: "turnstile", siteKey, verify: (token) => token === "good" });

const injectUser = (user: unknown) => async (c: Context, next: Next) => {
  if (user) c.set("user", user as never);
  await next();
};

const buildApp = (middlewareConfig: Parameters<typeof createAbuseMiddleware>[1], user?: unknown) => {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", injectUser(user));
  app.use("*", createAbuseMiddleware("todos", middlewareConfig));
  app.get("/api/todos", (c) => c.json({ items: [] }));
  app.post("/api/todos", (c) => c.json({ created: true }, 201));
  return app;
};

const postCreate = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ title: "x" }),
  });

describe("captcha gate (always-on)", () => {
  it("issues a 428 with captcha headers and accepts a valid token", async () => {
    abuseProtection({ captcha: { provider: stubProvider("sk-1") } });
    const app = buildApp({ captcha: { operations: ["create"] } });

    const challenge = await postCreate(app);
    expect(challenge.status).toBe(428);
    expect(challenge.headers.get("Covara-Challenge-Type")).toBe("captcha");
    expect(challenge.headers.get("Covara-Captcha-Provider")).toBe("turnstile");
    expect(challenge.headers.get("Covara-Captcha-Sitekey")).toBe("sk-1");

    const ok = await postCreate(app, { "Covara-Captcha-Token": "good" });
    expect(ok.status).toBe(201);

    const bad = await postCreate(app, { "Covara-Captcha-Token": "nope" });
    expect(bad.status).toBe(428);
  });

  it("skips the challenge when the required hook returns false", async () => {
    abuseProtection({ captcha: { provider: stubProvider() } });
    const app = buildApp({ captcha: { operations: ["create"], required: () => false } });
    expect((await postCreate(app)).status).toBe(201);
  });

  it("forwards a reCAPTCHA action to verify", async () => {
    const verify = vi.fn(async (_t: string, ctx?: { action?: string }) => ctx?.action === "create");
    abuseProtection({ captcha: { provider: customCaptcha({ siteKey: "sk", verify }) } });
    const app = buildApp({ captcha: { operations: ["create"], action: "create" } });
    const ok = await postCreate(app, { "Covara-Captcha-Token": "x" });
    expect(ok.status).toBe(201);
    expect(verify).toHaveBeenCalledWith("x", expect.objectContaining({ action: "create" }));
  });
});

describe("captcha as the budget overflow valve", () => {
  it("challenges with captcha once over budget and serves a valid token", async () => {
    abuseProtection({
      captcha: { provider: stubProvider() },
      budget: { enabled: true, classes: { anonymous: { capacity: 10, refillPerMinute: 0 } } },
      overflow: "captcha",
    });
    const app = buildApp({ cost: { create: 10 } });

    expect((await postCreate(app)).status).toBe(201); // 10 -> 0
    const over = await postCreate(app);
    expect(over.status).toBe(428);
    expect(over.headers.get("Covara-Challenge-Type")).toBe("captcha");
    // Solving pays the overdraft.
    expect((await postCreate(app, { "Covara-Captcha-Token": "good" })).status).toBe(201);
  });

  it("falls back to PoW overflow when captcha is requested but not configured", async () => {
    abuseProtection({
      // no captcha provider configured
      budget: { enabled: true, classes: { anonymous: { capacity: 10, refillPerMinute: 0 } } },
      pow: { difficulty: 8 },
      overflow: "captcha",
    });
    const app = buildApp({ cost: { create: 10 } });
    expect((await postCreate(app)).status).toBe(201);
    const over = await postCreate(app);
    expect(over.status).toBe(428);
    expect(over.headers.get("Covara-Challenge-Type")).toBe("pow");
  });
});

describe("captcha precedence over PoW", () => {
  it("issues a captcha challenge when an endpoint has both gates", async () => {
    abuseProtection({ captcha: { provider: stubProvider() }, pow: { difficulty: 8 } });
    const app = buildApp({
      pow: { difficulty: 8, operations: ["create"] },
      captcha: { operations: ["create"] },
    });
    const challenge = await postCreate(app);
    expect(challenge.status).toBe(428);
    expect(challenge.headers.get("Covara-Challenge-Type")).toBe("captcha");
    expect((await postCreate(app, { "Covara-Captcha-Token": "good" })).status).toBe(201);
  });
});
