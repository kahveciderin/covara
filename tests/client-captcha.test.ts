import { describe, it, expect, vi, afterEach } from "vitest";
import { FetchTransport, TransportError } from "../src/client/transport";

const captchaChallenge = () =>
  new Response(
    JSON.stringify({ type: "x", title: "captcha", status: 428, code: "CAPTCHA_REQUIRED" }),
    {
      status: 428,
      headers: {
        "content-type": "application/problem+json",
        "Covara-Challenge-Type": "captcha",
        "Covara-Captcha-Provider": "turnstile",
        "Covara-Captcha-Sitekey": "site-key-123",
        "Covara-Captcha-Action": "create",
      },
    }
  );

interface ServerOpts {
  alwaysChallenge?: boolean;
  validToken?: string;
}

const makeServer = (opts: ServerOpts = {}) => {
  const validToken = opts.validToken ?? "tok-ok";
  return vi.fn(async (_url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers["Covara-Captcha-Token"];
    if (!opts.alwaysChallenge && token === validToken) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return captchaChallenge();
  });
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client CAPTCHA handling", () => {
  it("solves a captcha challenge via the solver and retries transparently", async () => {
    globalThis.fetch = makeServer() as never;
    const solve = vi.fn(async () => "tok-ok");

    const transport = new FetchTransport({ baseUrl: "http://localhost", captcha: { solve } });
    const res = await transport.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/todos",
      body: { title: "hi" },
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(solve).toHaveBeenCalledWith({
      provider: "turnstile",
      siteKey: "site-key-123",
      action: "create",
    });
  });

  it("surfaces a CaptchaRequired TransportError when no solver is registered", async () => {
    globalThis.fetch = makeServer() as never;
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: {} })
    ).rejects.toSatisfy((e: unknown) => e instanceof TransportError && e.isCaptchaRequired());
  });

  it("gives up when the solver returns null", async () => {
    const fetchMock = makeServer();
    globalThis.fetch = fetchMock as never;
    const solve = vi.fn(async () => null);
    const transport = new FetchTransport({ baseUrl: "http://localhost", captcha: { solve } });

    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: {} })
    ).rejects.toMatchObject({ status: 428 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(solve).toHaveBeenCalledTimes(1);
  });

  it("stops after maxAttempts when the server keeps challenging", async () => {
    const fetchMock = makeServer({ alwaysChallenge: true });
    globalThis.fetch = fetchMock as never;
    const solve = vi.fn(async () => "whatever");
    const transport = new FetchTransport({
      baseUrl: "http://localhost",
      captcha: { solve, maxAttempts: 2 },
    });

    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: {} })
    ).rejects.toMatchObject({ status: 428 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("can be registered after construction via setCaptchaSolver", async () => {
    globalThis.fetch = makeServer() as never;
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    transport.setCaptchaSolver(async () => "tok-ok");
    const res = await transport.request({ method: "POST", path: "/api/todos", body: {} });
    expect(res.status).toBe(200);
  });

  it("does not call the captcha solver for a PoW challenge", async () => {
    // A pow-typed 428 with no pow headers won't be solvable; assert the captcha
    // solver is never invoked for it.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: "PROOF_OF_WORK_REQUIRED" }), {
        status: 428,
        headers: { "content-type": "application/problem+json", "Covara-Challenge-Type": "pow" },
      })
    ) as never;
    const solve = vi.fn(async () => "tok");
    const transport = new FetchTransport({ baseUrl: "http://localhost", captcha: { solve } });
    await expect(
      transport.request({ method: "POST", path: "/api/todos", body: {} })
    ).rejects.toMatchObject({ status: 428 });
    expect(solve).not.toHaveBeenCalled();
  });

  it("TransportError distinguishes captcha from pow via the challenge-type header", () => {
    const captcha = new TransportError("x", 428, "CAPTCHA_REQUIRED", undefined,
      new Headers({ "Covara-Challenge-Type": "captcha", "Covara-Captcha-Provider": "hcaptcha", "Covara-Captcha-Sitekey": "k" }));
    expect(captcha.isCaptchaRequired()).toBe(true);
    expect(captcha.isProofOfWorkRequired()).toBe(false);
    expect(captcha.captchaProvider).toBe("hcaptcha");
    expect(captcha.captchaSiteKey).toBe("k");

    const pow = new TransportError("x", 428, "PROOF_OF_WORK_REQUIRED", undefined,
      new Headers({ "Covara-Challenge-Type": "pow" }));
    expect(pow.isProofOfWorkRequired()).toBe(true);
    expect(pow.isCaptchaRequired()).toBe(false);
  });
});
