import { describe, it, expect } from "vitest";
import { calculateBackoff, shouldRetry, resolveRetryDelay } from "@/tasks/retry";
import { RetryConfig } from "@/tasks/types";

describe("calculateBackoff", () => {
  describe("exponential backoff", () => {
    it("should calculate exponential backoff correctly", () => {
      const config: RetryConfig = {
        backoff: "exponential",
        initialDelayMs: 1000,
        maxDelayMs: 60000,
      };

      const delay1 = calculateBackoff(1, config);
      const delay2 = calculateBackoff(2, config);
      const delay3 = calculateBackoff(3, config);
      const delay4 = calculateBackoff(4, config);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThan(1300);

      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeLessThan(2600);

      expect(delay3).toBeGreaterThanOrEqual(4000);
      expect(delay3).toBeLessThan(5200);

      expect(delay4).toBeGreaterThanOrEqual(8000);
      expect(delay4).toBeLessThan(10400);
    });

    it("should cap at maxDelayMs", () => {
      const config: RetryConfig = {
        backoff: "exponential",
        initialDelayMs: 1000,
        maxDelayMs: 5000,
      };

      const delay10 = calculateBackoff(10, config);

      expect(delay10).toBeGreaterThanOrEqual(5000);
      expect(delay10).toBeLessThan(6500);
    });

    it("should use defaults when not specified", () => {
      const delay = calculateBackoff(1, {});

      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThan(1300);
    });
  });

  describe("linear backoff", () => {
    it("should calculate linear backoff correctly", () => {
      const config: RetryConfig = {
        backoff: "linear",
        initialDelayMs: 1000,
        maxDelayMs: 60000,
      };

      const delay1 = calculateBackoff(1, config);
      const delay2 = calculateBackoff(2, config);
      const delay3 = calculateBackoff(3, config);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThan(1300);

      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeLessThan(2600);

      expect(delay3).toBeGreaterThanOrEqual(3000);
      expect(delay3).toBeLessThan(3900);
    });

    it("should cap at maxDelayMs for linear", () => {
      const config: RetryConfig = {
        backoff: "linear",
        initialDelayMs: 1000,
        maxDelayMs: 3000,
      };

      const delay10 = calculateBackoff(10, config);

      expect(delay10).toBeGreaterThanOrEqual(3000);
      expect(delay10).toBeLessThan(3900);
    });
  });

  describe("fixed backoff", () => {
    it("should return fixed delay for all attempts", () => {
      const config: RetryConfig = {
        backoff: "fixed",
        initialDelayMs: 5000,
      };

      const delay1 = calculateBackoff(1, config);
      const delay2 = calculateBackoff(2, config);
      const delay5 = calculateBackoff(5, config);

      expect(delay1).toBeGreaterThanOrEqual(5000);
      expect(delay1).toBeLessThan(6500);

      expect(delay2).toBeGreaterThanOrEqual(5000);
      expect(delay2).toBeLessThan(6500);

      expect(delay5).toBeGreaterThanOrEqual(5000);
      expect(delay5).toBeLessThan(6500);
    });
  });

  describe("jitter", () => {
    it("should add 10-20% jitter to delays", () => {
      const config: RetryConfig = {
        backoff: "fixed",
        initialDelayMs: 1000,
      };

      const delays = new Set<number>();
      for (let i = 0; i < 10; i++) {
        delays.add(calculateBackoff(1, config));
      }

      expect(delays.size).toBeGreaterThan(1);
    });
  });
});

describe("shouldRetry", () => {
  it("should return false when attempt >= maxAttempts", () => {
    const error = new Error("Some error");

    expect(shouldRetry(error, 3, 3)).toBe(false);
    expect(shouldRetry(error, 4, 3)).toBe(false);
    expect(shouldRetry(error, 10, 3)).toBe(false);
  });

  it("should return true when attempt < maxAttempts", () => {
    const error = new Error("Some error");

    expect(shouldRetry(error, 1, 3)).toBe(true);
    expect(shouldRetry(error, 2, 3)).toBe(true);
    expect(shouldRetry(error, 0, 3)).toBe(true);
  });

  it("should use custom retryOn function when provided", () => {
    const networkError = new Error("Network timeout");
    networkError.name = "NetworkError";

    const validationError = new Error("Invalid input");
    validationError.name = "ValidationError";

    const config: RetryConfig = {
      retryOn: (error) => error.name !== "ValidationError",
    };

    expect(shouldRetry(networkError, 1, 3, config)).toBe(true);
    expect(shouldRetry(validationError, 1, 3, config)).toBe(false);
  });

  it("should respect maxAttempts even with custom retryOn", () => {
    const error = new Error("Retryable");
    const config: RetryConfig = {
      retryOn: () => true,
    };

    expect(shouldRetry(error, 3, 3, config)).toBe(false);
  });

  it("should handle edge case of zero max attempts", () => {
    const error = new Error("Error");

    expect(shouldRetry(error, 0, 0)).toBe(false);
    expect(shouldRetry(error, 1, 0)).toBe(false);
  });

  it("should handle negative attempt numbers", () => {
    const error = new Error("Error");

    expect(shouldRetry(error, -1, 3)).toBe(true);
  });

  describe("common retry scenarios", () => {
    it("should retry on network errors", () => {
      const config: RetryConfig = {
        retryOn: (error) => {
          const retryable = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"];
          return retryable.includes((error as NodeJS.ErrnoException).code || "");
        },
      };

      const connReset = new Error("Connection reset") as NodeJS.ErrnoException;
      connReset.code = "ECONNRESET";

      const timeout = new Error("Timed out") as NodeJS.ErrnoException;
      timeout.code = "ETIMEDOUT";

      const notFound = new Error("Not found") as NodeJS.ErrnoException;
      notFound.code = "ENOTFOUND";

      const unknown = new Error("Unknown");

      expect(shouldRetry(connReset, 1, 3, config)).toBe(true);
      expect(shouldRetry(timeout, 1, 3, config)).toBe(true);
      expect(shouldRetry(notFound, 1, 3, config)).toBe(true);
      expect(shouldRetry(unknown, 1, 3, config)).toBe(false);
    });

    it("should not retry on HTTP 4xx errors", () => {
      interface HttpError extends Error {
        status: number;
      }

      const config: RetryConfig = {
        retryOn: (error) => {
          const httpError = error as HttpError;
          if (httpError.status >= 400 && httpError.status < 500) {
            return false;
          }
          return true;
        },
      };

      const badRequest = Object.assign(new Error("Bad Request"), { status: 400 });
      const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 });
      const notFound = Object.assign(new Error("Not Found"), { status: 404 });
      const serverError = Object.assign(new Error("Server Error"), { status: 500 });

      expect(shouldRetry(badRequest, 1, 3, config)).toBe(false);
      expect(shouldRetry(unauthorized, 1, 3, config)).toBe(false);
      expect(shouldRetry(notFound, 1, 3, config)).toBe(false);
      expect(shouldRetry(serverError, 1, 3, config)).toBe(true);
    });
  });
});

describe("resolveRetryDelay", () => {
  it("falls back to calculateBackoff without an override", () => {
    const delay = resolveRetryDelay(new Error("x"), 1, { initialDelayMs: 1000, backoff: "fixed" });
    expect(delay).toBeGreaterThanOrEqual(1100);
    expect(delay).toBeLessThanOrEqual(1200);
  });

  it("uses retryDelayMs when it returns a value", () => {
    const config: RetryConfig = { retryDelayMs: (_error, attempt) => attempt * 500 };
    expect(resolveRetryDelay(new Error("x"), 3, config)).toBe(1500);
  });

  it("falls back when retryDelayMs returns undefined, a negative, or a non-finite value", () => {
    for (const value of [undefined, -1, NaN, Infinity]) {
      const delay = resolveRetryDelay(new Error("x"), 1, {
        initialDelayMs: 100,
        backoff: "fixed",
        retryDelayMs: () => value,
      });
      expect(delay).toBeGreaterThanOrEqual(110);
      expect(delay).toBeLessThanOrEqual(120);
    }
  });

  it("allows a zero-delay override", () => {
    expect(resolveRetryDelay(new Error("x"), 1, { retryDelayMs: () => 0 })).toBe(0);
  });
});
