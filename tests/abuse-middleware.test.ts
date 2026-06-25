import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono, type Context, type Next } from "hono";
import { createAbuseMiddleware } from "../src/abuse/middleware";
import {
  abuseProtection,
  clearGlobalAbuseProtection,
} from "../src/abuse/config";
import { clearBudgetMemoryForTests } from "../src/abuse/budget";
import { clearReplayCacheForTests } from "../src/pow/server";
import { errorHandler } from "../src/middleware/error";
import { solveChallenge } from "../src/pow/core";
import { clearGlobalKV } from "../src/kv";

const injectUser = (user: unknown) => async (c: Context, next: Next) => {
  if (user) c.set("user", user as never);
  await next();
};

interface BuildOpts {
  user?: unknown;
  middlewareConfig: Parameters<typeof createAbuseMiddleware>[1];
}

const buildApp = ({ user, middlewareConfig }: BuildOpts) => {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", injectUser(user));
  app.use("*", createAbuseMiddleware("todos", middlewareConfig));
  app.get("/api/todos", (c) => c.json({ items: [] }));
  app.post("/api/todos", (c) => c.json({ created: true }, 201));
  return app;
};

const solveAndResend = async (
  app: Hono,
  res: Response,
  body: string
): Promise<Response> => {
  const token = res.headers.get("Covara-PoW-Challenge")!;
  const difficulty = Number(res.headers.get("Covara-PoW-Difficulty"));
  const nonce = solveChallenge(token, difficulty);
  return app.request("/api/todos", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Covara-PoW-Challenge": token,
      "Covara-PoW-Nonce": nonce,
    },
    body,
  });
};

beforeEach(() => {
  process.env.COVARA_POW_SECRET = "middleware-test-secret";
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
  clearReplayCacheForTests();
});

afterEach(() => {
  delete process.env.COVARA_POW_SECRET;
  clearGlobalAbuseProtection();
});

describe("abuse middleware — budget", () => {
  it("charges cost and hard-rejects with 429 when exhausted and PoW is disabled", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 70, refillPerMinute: 0 } } },
      pow: { enabled: false }, // disable the overflow valve -> hard 429
    });
    const app = buildApp({ middlewareConfig: { cost: { read: 30 } } });

    expect((await app.request("/api/todos")).status).toBe(200);
    expect((await app.request("/api/todos")).status).toBe(200);
    const third = await app.request("/api/todos");
    expect(third.status).toBe(429);
  });

  it("does not charge when no global budget is configured", async () => {
    const app = buildApp({ middlewareConfig: { cost: { read: 9999 } } });
    for (let i = 0; i < 5; i++) {
      expect((await app.request("/api/todos")).status).toBe(200);
    }
  });

  it("keys authenticated and anonymous callers to separate buckets", async () => {
    abuseProtection({
      budget: {
        enabled: true,
        classes: {
          anonymous: { capacity: 10, refillPerMinute: 0 },
          authenticated: { capacity: 1000, refillPerMinute: 0 },
        },
      },
      pow: { enabled: false },
    });
    const anon = buildApp({ middlewareConfig: { cost: { read: 10 } } });
    expect((await anon.request("/api/todos")).status).toBe(200);
    expect((await anon.request("/api/todos")).status).toBe(429);

    const authed = buildApp({
      user: { id: "u1" },
      middlewareConfig: { cost: { read: 10 } },
    });
    for (let i = 0; i < 5; i++) {
      expect((await authed.request("/api/todos")).status).toBe(200);
    }
  });
});

describe("abuse middleware — proof of work", () => {
  const body = JSON.stringify({ title: "hi" });

  it("issues a 428 challenge with headers, then accepts a solution", async () => {
    abuseProtection({ pow: { difficulty: 8 } });
    const app = buildApp({ middlewareConfig: { pow: { difficulty: 8, operations: ["create"] } } });

    const challenge = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(challenge.status).toBe(428);
    expect(challenge.headers.get("Covara-PoW-Challenge")).toBeTruthy();
    expect(challenge.headers.get("Covara-PoW-Difficulty")).toBe("8");
    expect(challenge.headers.get("Covara-PoW-Algorithm")).toBe("sha256");

    const solved = await solveAndResend(app, challenge, body);
    expect(solved.status).toBe(201);
  });

  it("rejects a replayed solution (one-time-use)", async () => {
    abuseProtection({ pow: { difficulty: 8 } });
    const app = buildApp({ middlewareConfig: { pow: { difficulty: 8, operations: ["create"] } } });

    const challenge = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const token = challenge.headers.get("Covara-PoW-Challenge")!;
    const nonce = solveChallenge(token, 8);

    const first = await app.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Covara-PoW-Challenge": token,
        "Covara-PoW-Nonce": nonce,
      },
      body,
    });
    expect(first.status).toBe(201);

    const replay = await app.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Covara-PoW-Challenge": token,
        "Covara-PoW-Nonce": nonce,
      },
      body,
    });
    expect(replay.status).toBe(428);
  });

  it("rejects a solution bound to a different body", async () => {
    abuseProtection({ pow: { difficulty: 8 } });
    const app = buildApp({ middlewareConfig: { pow: { difficulty: 8, operations: ["create"] } } });
    const challenge = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const token = challenge.headers.get("Covara-PoW-Challenge")!;
    const nonce = solveChallenge(token, 8);
    const tampered = await app.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Covara-PoW-Challenge": token,
        "Covara-PoW-Nonce": nonce,
      },
      body: JSON.stringify({ title: "different" }),
    });
    expect(tampered.status).toBe(428);
  });

  it("a trust hook returning 0 difficulty skips the challenge", async () => {
    abuseProtection({ pow: { difficulty: 16, getDifficulty: () => 0 } });
    const app = buildApp({ middlewareConfig: { pow: true } });
    const res = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
  });

  it("does not gate read operations when pow:true (mutations only)", async () => {
    abuseProtection({ pow: { difficulty: 8 } });
    const app = buildApp({ middlewareConfig: { pow: true } });
    expect((await app.request("/api/todos")).status).toBe(200);
  });
});

describe("abuse middleware — budget overflow valve", () => {
  const body = JSON.stringify({ title: "hi" });

  it("serves within budget, challenges (428) on overflow, and a solved challenge drains to zero", async () => {
    abuseProtection({
      pow: { difficulty: 8 },
      budget: { enabled: true, classes: { anonymous: { capacity: 20, refillPerMinute: 0 } } },
    });
    // cost only — no endpoint pow. PoW appears purely as the overflow valve.
    const app = buildApp({ middlewareConfig: { cost: { create: 10 } } });

    const create = () =>
      app.request("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

    // Within budget: no challenge.
    expect((await create()).status).toBe(201); // 20 -> 10
    expect((await create()).status).toBe(201); // 10 -> 0

    // Over budget: challenged instead of hard-rejected.
    const challenge = await create();
    expect(challenge.status).toBe(428);

    // Solving pays the overdraft; the request is served.
    expect((await solveAndResend(app, challenge, body)).status).toBe(201);

    // Still over budget afterwards -> challenged again (drained to zero).
    expect((await create()).status).toBe(428);
  });

  it("does not charge the budget for an unsolved challenge", async () => {
    abuseProtection({
      pow: { difficulty: 8 },
      budget: { enabled: true, classes: { anonymous: { capacity: 5, refillPerMinute: 0 } } },
    });
    // create costs 10 > capacity 5 -> always over budget -> always challenged.
    const app = buildApp({ middlewareConfig: { cost: { create: 10 } } });
    const challenge = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(challenge.status).toBe(428);
    // Solving still works (budget never went negative / was not pre-spent).
    expect((await solveAndResend(app, challenge, body)).status).toBe(201);
  });
});
