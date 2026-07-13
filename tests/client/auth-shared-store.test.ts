import { describe, it, expect, vi } from "vitest";
import { getAuthStore } from "@/client/react";

// Regression: useAuth previously kept per-instance useState, so a login in one
// component left a second useAuth() stuck on "loading". State now lives in a
// shared store keyed by identity — this exercises that store's contract.
describe("useAuth shared store", () => {
  it("returns the same store instance for the same key", () => {
    const a = getAuthStore("session:https://x:/api/auth/me");
    const b = getAuthStore("session:https://x:/api/auth/me");
    expect(a).toBe(b);
  });

  it("isolates stores across different keys", () => {
    const a = getAuthStore("session:https://x:/api/auth/me");
    const b = getAuthStore("bearer:https://x:token-123");
    expect(a).not.toBe(b);
  });

  it("notifies every subscriber when state changes (cross-instance sync)", () => {
    const store = getAuthStore("session:https://sync-test:/me");
    const sub1 = vi.fn();
    const sub2 = vi.fn();
    const un1 = store.subscribe(sub1);
    const un2 = store.subscribe(sub2);

    store.setState({ user: { id: "u1" }, status: "authenticated" });

    expect(sub1).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe("authenticated");
    expect((store.getSnapshot().user as any).id).toBe("u1");

    un1();
    store.setState({ status: "unauthenticated", user: null });
    // sub1 unsubscribed, sub2 still listening.
    expect(sub1).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(2);
    un2();
  });

  it("does not notify when the next state is identical", () => {
    const store = getAuthStore("session:https://noop-test:/me");
    store.setState({ status: "unauthenticated", user: null, accessToken: null });
    const sub = vi.fn();
    const un = store.subscribe(sub);

    store.setState({ status: "unauthenticated" });
    store.setState({ user: null });

    expect(sub).not.toHaveBeenCalled();
    un();
  });
});
