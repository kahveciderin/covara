import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createCovara } from "@/server/app";
import { abuseProtection, clearGlobalAbuseProtection } from "@/abuse/config";
import { customCaptcha } from "@/abuse/captcha";
import { clearBudgetMemoryForTests } from "@/abuse/budget";
import { clearReplayCacheForTests } from "@/pow/server";
import { clearGlobalKV } from "@/kv";
import { FetchTransport, TransportError } from "@/client/transport";

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

const originalFetch = globalThis.fetch;

let sqlite: Database.Database;

interface StackOpts {
  powDifficulty: number;
  createCost: number;
  capacity: number;
  powEnabled?: boolean;
}

const buildStack = ({ powDifficulty, createCost, capacity, powEnabled = true }: StackOpts) => {
  sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  const db = drizzle(sqlite);

  const app = createCovara({
    abuseProtection: abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity, refillPerMinute: 0 } } },
      pow: powEnabled ? { difficulty: powDifficulty } : { enabled: false },
    }),
    securityHeaders: false,
  });
  app.resource("/todos", todos, {
    db,
    id: todos.id,
    auth: { public: { read: true, create: true } },
    // cost only — PoW shows up purely as the budget overflow valve.
    cost: { create: createCost },
  });

  // Route the real client transport at the in-process app, counting 428s so we
  // can assert the overflow valve actually engaged.
  let challenges = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await app.fetch(new Request(input as never, init));
    if (res.status === 428) challenges++;
    return res;
  }) as never;

  const transport = new FetchTransport({ baseUrl: "http://localhost" });
  return { transport, sqlite, challenges: () => challenges };
};

beforeEach(() => {
  process.env.COVARA_POW_SECRET = "e2e-secret";
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
  clearReplayCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.COVARA_POW_SECRET;
  clearGlobalAbuseProtection();
  sqlite?.close();
});

describe("abuse protection end-to-end (createCovara + real client transport)", () => {
  it("serves within budget with no challenge", async () => {
    const { transport, sqlite, challenges } = buildStack({ powDifficulty: 8, createCost: 5, capacity: 1000 });

    const res = await transport.request<{ data: { id: string } }>({
      method: "POST",
      path: "/api/todos",
      body: { id: "t1", title: "hello" },
    });

    expect(res.status).toBe(201);
    expect(challenges()).toBe(0);
    const row = sqlite.prepare("SELECT * FROM todos WHERE id = ?").get("t1") as
      | { id: string; title: string }
      | undefined;
    expect(row?.title).toBe("hello");
  });

  it("transparently solves the overflow PoW challenge once over budget", async () => {
    // capacity 100, cost 40 -> two creates within budget, the rest overflow and
    // the client solves the PoW challenges without the caller noticing.
    const { transport, sqlite, challenges } = buildStack({ powDifficulty: 8, createCost: 40, capacity: 100 });

    for (const id of ["a", "b", "c", "d"]) {
      const res = await transport.request({ method: "POST", path: "/api/todos", body: { id, title: id } });
      expect(res.status).toBe(201);
    }

    // All four rows were created even though the budget only covered two.
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM todos").get() as { n: number };
    expect(count.n).toBe(4);
    // The 3rd and 4th were over budget -> the overflow valve engaged.
    expect(challenges()).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a 429 once the budget is exhausted when PoW is disabled", async () => {
    const { transport } = buildStack({ powDifficulty: 8, createCost: 40, capacity: 100, powEnabled: false });

    expect((await transport.request({ method: "POST", path: "/api/todos", body: { id: "a", title: "a" } })).status).toBe(201);
    expect((await transport.request({ method: "POST", path: "/api/todos", body: { id: "b", title: "b" } })).status).toBe(201);
    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: { id: "c", title: "c" } })
    ).rejects.toMatchObject({ status: 429 });
  });

  it("a GET (read, no cost configured) is unaffected", async () => {
    const { transport } = buildStack({ powDifficulty: 8, createCost: 5, capacity: 1000 });
    const res = await transport.request({ method: "GET", path: "/api/todos" });
    expect(res.status).toBe(200);
  });
});

describe("CAPTCHA end-to-end (createCovara + real client transport)", () => {
  const buildCaptchaStack = () => {
    sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    const db = drizzle(sqlite);

    const app = createCovara({
      abuseProtection: abuseProtection({
        captcha: { provider: customCaptcha({ siteKey: "sk", verify: (t) => t === "good" }) },
      }),
      securityHeaders: false,
    });
    app.resource("/todos", todos, {
      db,
      id: todos.id,
      auth: { public: { read: true, create: true } },
      captcha: { operations: ["create"] },
    });

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input as never, init))) as never;
    return { app };
  };

  it("solves the CAPTCHA via the registered solver and serves the request", async () => {
    buildCaptchaStack();
    const solve = vi.fn(async () => "good");
    const transport = new FetchTransport({ baseUrl: "http://localhost", captcha: { solve } });

    const res = await transport.request({ method: "POST", path: "/api/todos", body: { id: "t1", title: "x" } });
    expect(res.status).toBe(201);
    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ provider: "custom", siteKey: "sk" }));
  });

  it("surfaces a CaptchaRequired error when no solver is registered", async () => {
    buildCaptchaStack();
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: { id: "t2", title: "x" } })
    ).rejects.toSatisfy((e: unknown) => e instanceof TransportError && e.isCaptchaRequired());
  });
});
