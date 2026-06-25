import { describe, it, expect, vi, afterEach } from "vitest";
import { CaptchaController } from "../src/client/captcha";
import { FetchTransport } from "../src/client/transport";

const waitFor = async (cond: () => boolean, tries = 50): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: condition not met");
};

describe("CaptchaController", () => {
  it("parks a challenge and resolves it with the supplied token", async () => {
    const c = new CaptchaController();
    let notified = 0;
    c.subscribe(() => notified++);

    const promise = c.solver({ provider: "turnstile", siteKey: "k", action: "create" });
    expect(c.getCurrent()?.challenge.provider).toBe("turnstile");
    expect(notified).toBe(1);

    c.resolveCurrent("the-token");
    expect(await promise).toBe("the-token");
    expect(c.getCurrent()).toBeNull();
    expect(notified).toBe(2);
  });

  it("supersedes a pending challenge, resolving the old one as unsolved", async () => {
    const c = new CaptchaController();
    const first = c.solver({ provider: "turnstile" });
    const second = c.solver({ provider: "hcaptcha" });
    expect(await first).toBeNull();
    expect(c.getCurrent()?.challenge.provider).toBe("hcaptcha");
    c.resolveCurrent("tok");
    expect(await second).toBe("tok");
  });
});

describe("CovaraCaptcha wiring (controller + transport, no DOM)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("drives a transparent retry the way <CovaraCaptcha/> would", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (headers["Covara-Captcha-Token"] === "solved") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "CAPTCHA_REQUIRED" }), {
        status: 428,
        headers: {
          "content-type": "application/problem+json",
          "Covara-Challenge-Type": "captcha",
          "Covara-Captcha-Provider": "turnstile",
          "Covara-Captcha-Sitekey": "sk",
        },
      });
    }) as never;

    const controller = new CaptchaController();
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    transport.setCaptchaSolver(controller.solver);

    const reqPromise = transport.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/todos",
      body: { title: "hi" },
    });

    // Simulate the React effect: a challenge appears, the widget yields a token.
    await waitFor(() => controller.getCurrent() !== null);
    expect(controller.getCurrent()?.challenge).toMatchObject({ provider: "turnstile", siteKey: "sk" });
    controller.resolveCurrent("solved");

    const res = await reqPromise;
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });
});
