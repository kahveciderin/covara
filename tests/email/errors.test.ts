import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EmailDeliveryError,
  isPermanentStatus,
  isRetryableEmailError,
  parseRetryAfter,
} from "@/email/errors";
import { createResendAdapter } from "@/email/resend";
import { createCloudflareEmailAdapter } from "@/email/cloudflare";

const response = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });

const msg = { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" };

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30000);
  });

  it("clamps past dates to zero", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for missing or garbage values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-3")).toBeUndefined();
  });
});

describe("status classification", () => {
  it("treats validation-style 4xx as permanent", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isPermanentStatus(status)).toBe(true);
    }
  });

  it("treats 408/409/425/429 and 5xx as transient", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isPermanentStatus(status)).toBe(false);
    }
  });

  it("treats unknown errors as retryable", () => {
    expect(isRetryableEmailError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableEmailError("weird")).toBe(true);
    expect(
      isRetryableEmailError(new EmailDeliveryError("x", { provider: "p", permanent: true }))
    ).toBe(false);
  });
});

describe("Resend typed errors", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws a permanent EmailDeliveryError on 422", async () => {
    fetchMock.mockResolvedValueOnce(response(422, "invalid from"));
    const error = await createResendAdapter({ apiKey: "k" })
      .send(msg)
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.status).toBe(422);
    expect(error.permanent).toBe(true);
    expect(error.provider).toBe("resend");
    expect(error.message).toMatch(/resend.*422.*invalid from/);
  });

  it("throws a transient error carrying Retry-After on 429", async () => {
    fetchMock.mockResolvedValueOnce(response(429, "slow down", { "Retry-After": "7" }));
    const error = await createResendAdapter({ apiKey: "k" })
      .send(msg)
      .catch((e) => e);
    expect(error.permanent).toBe(false);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
  });

  it("throws a transient error on 503", async () => {
    fetchMock.mockResolvedValueOnce(response(503, "down"));
    const error = await createResendAdapter({ apiKey: "k" })
      .send(msg)
      .catch((e) => e);
    expect(error.permanent).toBe(false);
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("wraps network failures as transient", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const error = await createResendAdapter({ apiKey: "k" })
      .send(msg)
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.permanent).toBe(false);
    expect(error.status).toBeUndefined();
    expect(error.message).toMatch(/resend: request failed: fetch failed/);
  });

  it("sends the Idempotency-Key header when given a key", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: "e1" }));
    await createResendAdapter({ apiKey: "k" }).send(msg, { idempotencyKey: "key-1" });
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("key-1");
  });

  it("omits the Idempotency-Key header without a key", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: "e1" }));
    await createResendAdapter({ apiKey: "k" }).send(msg);
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBeUndefined();
  });

  it("passes the Idempotency-Key header on batch sends", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { data: [{ id: "a" }] }));
    await createResendAdapter({ apiKey: "k" }).sendBatch!([msg], { idempotencyKey: "batch-1" });
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("batch-1");
  });
});

describe("Cloudflare typed errors", () => {
  it("marks missing recipients as permanent", async () => {
    const adapter = createCloudflareEmailAdapter({ binding: { send: vi.fn() } });
    const error = await adapter.send({ ...msg, to: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.permanent).toBe(true);
  });

  it("marks binding failures as transient", async () => {
    const adapter = createCloudflareEmailAdapter({
      binding: { send: vi.fn().mockRejectedValue(new Error("internal")) },
    });
    const error = await adapter.send(msg).catch((e) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.permanent).toBe(false);
  });
});
