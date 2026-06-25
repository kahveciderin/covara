import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { useAuth, type UseAuthOptions } from "../src/auth/routes";
import { cookieSession } from "../src/auth/session";
import { InMemorySessionStore } from "../src/auth/types";
import { errorHandler } from "../src/middleware/error";
import { abuseProtection, clearGlobalAbuseProtection } from "../src/abuse/config";
import { clearBudgetMemoryForTests } from "../src/abuse/budget";
import { clearReplayCacheForTests } from "../src/pow/server";
import { clearGlobalKV } from "../src/kv";
import { solveChallenge } from "../src/pow/core";

interface MockUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

let users: Map<string, MockUser>;

const buildApp = (opts: Pick<UseAuthOptions, "login" | "signup" | "passwordReset">) => {
  const store = new InMemorySessionStore();
  const { router, middleware } = useAuth({
    session: cookieSession({
      store,
      getUserById: async (id) => {
        const u = users.get(id);
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
    }),
    login: {
      validateCredentials: async (email, password) => {
        const u = [...users.values()].find(
          (x) => x.email === email && x.passwordHash === password
        );
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
      ...opts.login,
    },
    signup: {
      createUser: async ({ email, name }) => {
        const id = `new-${users.size}`;
        users.set(id, { id, email, name: name ?? "", passwordHash: "x" });
        return { id, email, name };
      },
      ...opts.signup,
    },
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/auth", router);
  app.use("*", middleware);
  return app;
};

const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.COVARA_POW_SECRET = "auth-test-secret";
  users = new Map([["u1", { id: "u1", email: "a@b.c", name: "A", passwordHash: "pw" }]]);
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
  clearReplayCacheForTests();
});

afterEach(() => {
  delete process.env.COVARA_POW_SECRET;
  clearGlobalAbuseProtection();
});

describe("auth abuse — failed login budget", () => {
  it("charges failed attempts and challenges with PoW once exhausted", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
    });
    const app = buildApp({ login: { cost: { failed: 20 } } });

    const first = await post(app, "/api/auth/login", { email: "a@b.c", password: "wrong" });
    expect(first.status).toBe(401); // charged 20, 10 remain

    // 10 < 20 -> over budget -> PoW challenge before validateCredentials.
    const second = await post(app, "/api/auth/login", { email: "a@b.c", password: "wrong" });
    expect(second.status).toBe(428);
  });

  it("hard-rejects with 429 once exhausted when PoW is disabled", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
      pow: { enabled: false },
    });
    const app = buildApp({ login: { cost: { failed: 20 } } });

    expect((await post(app, "/api/auth/login", { email: "a@b.c", password: "wrong" })).status).toBe(401);
    expect((await post(app, "/api/auth/login", { email: "a@b.c", password: "wrong" })).status).toBe(429);
  });

  it("does not charge on a successful login (charge is deferred to failures)", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
    });
    const app = buildApp({ login: { cost: { failed: 20 } } });

    const first = await post(app, "/api/auth/login", { email: "a@b.c", password: "pw" });
    expect(first.status).toBe(200);
    // If a success were charged, only 10 tokens would remain and this second
    // success would be over budget; the deferred charge means it stays at 200.
    const second = await post(app, "/api/auth/login", { email: "a@b.c", password: "pw" });
    expect(second.status).toBe(200);
  });
});

describe("auth abuse — signup budget", () => {
  it("challenges with PoW once the signup budget is exhausted", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
    });
    const app = buildApp({ signup: { cost: 20 } });

    const first = await post(app, "/api/auth/signup", { email: "x@y.z", password: "longpassword" });
    expect(first.status).toBe(200);
    const second = await post(app, "/api/auth/signup", { email: "x2@y.z", password: "longpassword" });
    expect(second.status).toBe(428);
  });

  it("hard-rejects with 429 when PoW is disabled", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
      pow: { enabled: false },
    });
    const app = buildApp({ signup: { cost: 20 } });

    expect((await post(app, "/api/auth/signup", { email: "x@y.z", password: "longpassword" })).status).toBe(200);
    expect((await post(app, "/api/auth/signup", { email: "x2@y.z", password: "longpassword" })).status).toBe(429);
  });
});

describe("auth abuse — proof of work gate", () => {
  it("challenges signup then accepts a solved request", async () => {
    abuseProtection({ pow: { difficulty: 8 } });
    const app = buildApp({ signup: { pow: { difficulty: 8 } } });

    const body = JSON.stringify({ email: "p@o.w", password: "longpassword" });
    const challenge = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(challenge.status).toBe(428);
    const token = challenge.headers.get("Covara-PoW-Challenge")!;
    const nonce = solveChallenge(token, Number(challenge.headers.get("Covara-PoW-Difficulty")));

    const solved = await app.request("/api/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Covara-PoW-Challenge": token,
        "Covara-PoW-Nonce": nonce,
      },
      body,
    });
    expect(solved.status).toBe(200);
  });
});
