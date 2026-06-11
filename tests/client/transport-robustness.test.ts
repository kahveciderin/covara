import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchTransport, TransportError } from "../../src/client/transport";
import { computeBackoffDelay } from "../../src/client/subscription-manager";

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: () => Promise.resolve(body),
});

const unauthorized = () =>
  jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "nope" } });

describe("FetchTransport robustness", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("401 refresh-and-retry", () => {
    it("triggers exactly one refresh and one retry on 401", async () => {
      const refreshAuth = vi.fn(async () => "new-token" as const);
      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        refreshAuth,
      });

      mockFetch
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const result = await transport.request({ method: "GET", path: "/me" });

      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.data).toEqual({ ok: true });
    });

    it("does not strip user headers but removes internal retry marker before fetch", async () => {
      const refreshAuth = vi.fn(async () => undefined);
      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        refreshAuth,
      });

      mockFetch
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(jsonResponse(200, {}));

      await transport.request({
        method: "GET",
        path: "/me",
        headers: { "X-Foo": "bar" },
      });

      const secondHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
      expect(secondHeaders["X-Foo"]).toBe("bar");
      expect(secondHeaders["X-Concave-Retried"]).toBeUndefined();
    });

    it("surfaces the error if the retry also returns 401 (no infinite loop)", async () => {
      const refreshAuth = vi.fn(async () => "new-token");
      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        refreshAuth,
      });

      mockFetch
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(unauthorized());

      await expect(
        transport.request({ method: "GET", path: "/me" })
      ).rejects.toMatchObject({ status: 401 });

      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not refresh when no refreshAuth is configured", async () => {
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });
      mockFetch.mockResolvedValue(unauthorized());

      await expect(
        transport.request({ method: "GET", path: "/me" })
      ).rejects.toBeInstanceOf(TransportError);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("concurrent 401s share a single deduplicated refresh", async () => {
      // Mirror the TokenManager's refresh dedup: the underlying work runs once,
      // even when multiple in-flight requests trigger refreshAuth concurrently.
      let underlyingRefreshCount = 0;
      let inFlight: Promise<void> | null = null;
      let releaseRefresh!: () => void;
      const refreshAuth = vi.fn(() => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
          underlyingRefreshCount++;
          await new Promise<void>((r) => {
            releaseRefresh = r;
          });
          inFlight = null;
        })();
        return inFlight;
      });

      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        refreshAuth,
      });

      mockFetch.mockImplementation(async () => {
        return underlyingRefreshCount === 0
          ? unauthorized()
          : jsonResponse(200, { ok: true });
      });

      const p1 = transport.request({ method: "GET", path: "/a" });
      const p2 = transport.request({ method: "GET", path: "/b" });

      while (!releaseRefresh) {
        await Promise.resolve();
      }
      expect(refreshAuth.mock.calls.length).toBeGreaterThanOrEqual(1);
      releaseRefresh();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.data).toEqual({ ok: true });
      expect(r2.data).toEqual({ ok: true });
      expect(underlyingRefreshCount).toBe(1);
    });
  });

  describe("cancellation and timeouts", () => {
    it("a per-request AbortSignal cancels the request", async () => {
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });
      const controller = new AbortController();

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const promise = transport.request({
        method: "GET",
        path: "/slow",
        signal: controller.signal,
      });

      controller.abort();

      await expect(promise).rejects.toThrow(/abort/i);
    });

    it("a pre-aborted external signal aborts immediately", async () => {
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      await expect(
        transport.request({
          method: "GET",
          path: "/slow",
          signal: controller.signal,
        })
      ).rejects.toThrow(/abort/i);
    });

    it("per-request timeout aborts the request", async () => {
      vi.useFakeTimers();
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("timed out");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const promise = transport.request({
        method: "GET",
        path: "/slow",
        timeoutMs: 50,
      });
      const assertion = expect(promise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(50);
      await assertion;

      vi.useRealTimers();
    });

    it("global timeout still works and the timer is cleared on success", async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, "clearTimeout");
      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        timeout: 1000,
      });

      mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));

      const result = await transport.request({ method: "GET", path: "/fast" });
      expect(result.data).toEqual({ ok: true });
      expect(clearSpy).toHaveBeenCalled();

      // no pending timers should fire an abort after success
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();
    });

    it("per-request timeoutMs overrides the global timeout", async () => {
      vi.useFakeTimers();
      const transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        timeout: 100000,
      });

      let aborted = false;
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const promise = transport.request({
        method: "GET",
        path: "/slow",
        timeoutMs: 10,
      });
      const assertion = expect(promise).rejects.toThrow();

      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(aborted).toBe(true);

      vi.useRealTimers();
    });
  });
});

describe("computeBackoffDelay", () => {
  it("returns a value bounded by the cap", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = computeBackoffDelay(attempt, 1000, 30000, () => 1);
      expect(delay).toBeLessThanOrEqual(30000);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it("applies full jitter scaled by the rng", () => {
    // attempt 2 -> exponential 4000, bounded 4000
    expect(computeBackoffDelay(2, 1000, 30000, () => 0)).toBe(0);
    expect(computeBackoffDelay(2, 1000, 30000, () => 0.5)).toBe(2000);
    expect(computeBackoffDelay(2, 1000, 30000, () => 1)).toBe(4000);
  });

  it("caps the exponential growth before applying jitter", () => {
    // attempt 20 -> exponential is huge, bounded to cap 30000
    expect(computeBackoffDelay(20, 1000, 30000, () => 1)).toBe(30000);
    expect(computeBackoffDelay(20, 1000, 30000, () => 0.5)).toBe(15000);
  });

  it("is jittered across random draws (not constant)", () => {
    const delays = new Set<number>();
    let seed = 0.123;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < 50; i++) {
      delays.add(computeBackoffDelay(5, 1000, 30000, rng));
    }
    expect(delays.size).toBeGreaterThan(10);
  });

  it("defaults to Math.random and stays bounded", () => {
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffDelay(10, 1000, 30000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30000);
    }
  });
});
