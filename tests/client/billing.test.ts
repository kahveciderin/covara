import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchTransport } from "../../src/client/transport";
import {
  createBillingClient,
  isActiveSubscription,
  BillingSubscription,
  SubscriptionStatus,
} from "../../src/client/billing";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: () => Promise.resolve(body),
});

const makeSub = (
  status: SubscriptionStatus,
  id = "sub_1"
): BillingSubscription => ({
  id,
  customerId: "cus_1",
  status,
  provider: "stripe",
});

describe("BillingClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let transport: FetchTransport;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    transport = new FetchTransport({ baseUrl: "http://localhost:3000" });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("checkout", () => {
    it("POSTs the body to {base}/checkout and returns { id, url }", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: "cs_123", url: "https://pay.example/cs_123" })
      );
      const billing = createBillingClient({ transport });

      const result = await billing.checkout({
        plan: "pro",
        successUrl: "https://app.example/ok",
        cancelUrl: "https://app.example/cancel",
        trialDays: 14,
        metadata: { foo: "bar" },
      });

      expect(result).toEqual({ id: "cs_123", url: "https://pay.example/cs_123" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/billing/checkout");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        plan: "pro",
        successUrl: "https://app.example/ok",
        cancelUrl: "https://app.example/cancel",
        trialDays: 14,
        metadata: { foo: "bar" },
      });
    });

    it("honors a custom basePath", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: "x", url: "u" }));
      const billing = createBillingClient({ transport, basePath: "/billing" });

      await billing.checkout({ successUrl: "https://ok" });

      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:3000/billing/checkout"
      );
    });

    it("strips a trailing slash from basePath", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: "x", url: "u" }));
      const billing = createBillingClient({ transport, basePath: "/api/billing/" });

      await billing.checkout({ successUrl: "https://ok" });

      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:3000/api/billing/checkout"
      );
    });
  });

  describe("getCredits", () => {
    it("GETs {base}/credits and returns balance number", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ balance: 42 }));
      const billing = createBillingClient({ transport });

      const balance = await billing.getCredits();

      expect(balance).toBe(42);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/billing/credits");
      expect(init.method).toBe("GET");
    });
  });

  describe("getSubscription", () => {
    it("GETs {base}/subscription and returns the array", async () => {
      const subs = [makeSub("active"), makeSub("canceled", "sub_2")];
      mockFetch.mockResolvedValue(jsonResponse({ subscriptions: subs }));
      const billing = createBillingClient({ transport });

      const result = await billing.getSubscription();

      expect(result).toEqual(subs);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/billing/subscription");
      expect(init.method).toBe("GET");
    });

    it("defaults to an empty array when subscriptions is missing", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      const billing = createBillingClient({ transport });

      expect(await billing.getSubscription()).toEqual([]);
    });
  });

  describe("openPortal", () => {
    it("POSTs { returnUrl } to {base}/portal and returns { url }", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "https://portal.example/p" })
      );
      const billing = createBillingClient({ transport });

      const result = await billing.openPortal("https://app.example/account");

      expect(result).toEqual({ url: "https://portal.example/p" });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/billing/portal");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        returnUrl: "https://app.example/account",
      });
    });
  });

  describe("redirectToCheckout", () => {
    it("sets window.location.href when window is present", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: "cs", url: "https://pay.example/go" })
      );
      const location = { href: "" };
      vi.stubGlobal("window", { location });
      const billing = createBillingClient({ transport });

      await billing.redirectToCheckout({ successUrl: "https://ok" });

      expect(location.href).toBe("https://pay.example/go");
      vi.unstubAllGlobals();
    });

    it("does not throw when window is absent (SSR/RN)", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: "cs", url: "https://pay.example/go" })
      );
      const billing = createBillingClient({ transport });

      await expect(
        billing.redirectToCheckout({ successUrl: "https://ok" })
      ).resolves.toBeUndefined();
    });
  });

  describe("redirectToPortal", () => {
    it("sets window.location.href to the portal url", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "https://portal.example/x" })
      );
      const location = { href: "" };
      vi.stubGlobal("window", { location });
      const billing = createBillingClient({ transport });

      await billing.redirectToPortal("https://app.example/account");

      expect(location.href).toBe("https://portal.example/x");
      vi.unstubAllGlobals();
    });
  });

  describe("auth refresh integration", () => {
    it("retries once via transport refreshAuth on 401", async () => {
      const refreshAuth = vi.fn().mockResolvedValue("new-token");
      const t = new FetchTransport({
        baseUrl: "http://localhost:3000",
        refreshAuth,
      });
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: "no", code: "UNAUTHORIZED" } }, 401)
        )
        .mockResolvedValueOnce(jsonResponse({ balance: 7 }));

      const billing = createBillingClient({ transport: t });
      const balance = await billing.getCredits();

      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(balance).toBe(7);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("isActiveSubscription", () => {
  it("is true for active and trialing", () => {
    expect(isActiveSubscription(makeSub("active"))).toBe(true);
    expect(isActiveSubscription(makeSub("trialing"))).toBe(true);
  });

  it("is false for other statuses", () => {
    for (const status of [
      "past_due",
      "canceled",
      "paused",
      "incomplete",
      "expired",
      "unpaid",
    ] as SubscriptionStatus[]) {
      expect(isActiveSubscription(makeSub(status))).toBe(false);
    }
  });

  it("selects the first active subscription (useSubscription logic)", () => {
    const subs = [
      makeSub("canceled", "a"),
      makeSub("trialing", "b"),
      makeSub("active", "c"),
    ];
    const active = subs.find(isActiveSubscription) ?? null;
    expect(active?.id).toBe("b");
  });

  it("returns null when none are active", () => {
    const subs = [makeSub("canceled", "a"), makeSub("expired", "b")];
    expect(subs.find(isActiveSubscription) ?? null).toBeNull();
  });
});
