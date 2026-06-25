import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchTransport, TransportError } from "../src/client/transport";
import {
  computeFingerprint,
  issueChallenge,
  verifySolution,
} from "../src/pow/server";

const SECRET = "client-pow-secret";
const DIFFICULTY = 8;

interface MockServerOptions {
  alwaysChallenge?: boolean;
}

const makeServer = (opts: MockServerOptions = {}) => {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const bodyText = typeof init.body === "string" ? init.body : "";
    const fingerprint = computeFingerprint(method, u.pathname + u.search, bodyText);

    const token = headers["Covara-PoW-Challenge"];
    const nonce = headers["Covara-PoW-Nonce"];

    if (!opts.alwaysChallenge && token && nonce) {
      const verdict = verifySolution({ secret: SECRET, token, nonce, fingerprint });
      if (verdict.ok) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const issued = issueChallenge({ secret: SECRET, difficulty: DIFFICULTY, fingerprint });
    return new Response(
      JSON.stringify({ type: "x", title: "PoW", status: 428, code: "PROOF_OF_WORK_REQUIRED" }),
      {
        status: 428,
        headers: {
          "content-type": "application/problem+json",
          "Covara-PoW-Challenge": issued.token,
          "Covara-PoW-Difficulty": String(issued.difficulty),
          "Covara-PoW-Algorithm": issued.algorithm,
        },
      }
    );
  });
  return fetchMock;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client transparent proof-of-work", () => {
  it("solves a 428 challenge and resolves the request transparently", async () => {
    const fetchMock = makeServer();
    globalThis.fetch = fetchMock as never;

    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    const res = await transport.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/todos",
      body: { title: "hi" },
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // challenge, then solved
  });

  it("gives up after maxAttempts when the server keeps challenging", async () => {
    const fetchMock = makeServer({ alwaysChallenge: true });
    globalThis.fetch = fetchMock as never;

    const transport = new FetchTransport({
      baseUrl: "http://localhost",
      pow: { maxAttempts: 2 },
    });

    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: { title: "hi" } })
    ).rejects.toMatchObject({ status: 428 });
    // initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not solve when pow is disabled", async () => {
    const fetchMock = makeServer();
    globalThis.fetch = fetchMock as never;

    const transport = new FetchTransport({
      baseUrl: "http://localhost",
      pow: { enabled: false },
    });

    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: { title: "hi" } })
    ).rejects.toMatchObject({ status: 428 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a 429 (budget) without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "slow down", code: "RATE_LIMIT_EXCEEDED" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as never;

    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    await expect(
      transport.request({ method: "GET", path: "/api/todos" })
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes isProofOfWorkRequired on TransportError (by challenge type)", () => {
    const pow = new TransportError(
      "x",
      428,
      "PROOF_OF_WORK_REQUIRED",
      undefined,
      new Headers({ "Covara-Challenge-Type": "pow" })
    );
    expect(pow.isProofOfWorkRequired()).toBe(true);
    expect(pow.isCaptchaRequired()).toBe(false);
    expect(new TransportError("x", 400, "X").isProofOfWorkRequired()).toBe(false);
  });
});
