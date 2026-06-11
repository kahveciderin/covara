import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  beginShutdown,
  isShuttingDown,
  onShutdown,
  resetLifecycle,
} from "@/server/lifecycle";
import { createHealthEndpoints } from "@/health";

describe("Server lifecycle / graceful shutdown", () => {
  beforeEach(() => {
    resetLifecycle();
  });

  // The shutdown flag is process-global; reset after each test so it never
  // leaks into other test files (vitest shares module state within a fork).
  afterEach(() => {
    resetLifecycle();
  });

  it("starts not shutting down", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("flips the flag and runs hooks on beginShutdown", async () => {
    const order: string[] = [];
    onShutdown(() => {
      order.push("a");
    });
    onShutdown(async () => {
      order.push("b");
    });

    await beginShutdown();

    expect(isShuttingDown()).toBe(true);
    expect(order).toEqual(["a", "b"]);
  });

  it("is idempotent — hooks run once even if called twice", async () => {
    let count = 0;
    onShutdown(() => {
      count++;
    });

    await beginShutdown();
    await beginShutdown();

    expect(count).toBe(1);
  });

  it("continues running hooks even if one throws", async () => {
    const ran: string[] = [];
    onShutdown(() => {
      throw new Error("boom");
    });
    onShutdown(() => {
      ran.push("second");
    });

    await expect(beginShutdown()).resolves.toBeUndefined();
    expect(ran).toEqual(["second"]);
  });

  it("makes /readyz return 503 while draining", async () => {
    const health = createHealthEndpoints();

    const before = await health.request("/readyz");
    expect(before.status).toBe(200);

    await beginShutdown();

    const during = await health.request("/readyz");
    expect(during.status).toBe(503);
    const body = await during.json();
    expect(body.checks.some((c: { message?: string }) => c.message === "Server is shutting down")).toBe(true);
  });

  it("does not let draining affect /healthz (liveness is independent of readiness)", async () => {
    const health = createHealthEndpoints();
    await beginShutdown();
    const live = await health.request("/healthz");
    // Liveness must never report the shutdown/draining state — that's readiness'
    // job. (Status itself can vary with event-loop/memory load, so we assert on
    // the absence of the shutdown signal rather than a hard 200.)
    const body = await live.json();
    expect(
      body.checks.some((c: { message?: string }) => c.message === "Server is shutting down")
    ).toBe(false);
  });
});
