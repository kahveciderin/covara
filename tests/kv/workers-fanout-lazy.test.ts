import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryKV } from "@/kv/memory";
import { setGlobalKV, clearGlobalKV } from "@/kv";
import type { KVAdapter, ScopedSubscription } from "@/kv/types";
import type { SSEWriter } from "@/server/sse";
import {
  registerHandler,
  unregisterHandler,
  initializeEventSubscription,
  clearAllSubscriptions,
} from "@/resource/subscription";

const fakeWriter = (): SSEWriter => ({
  write: () => true,
  close: () => {},
  closed: false,
  bufferedBytes: 0,
  backpressured: false,
  onClose: () => {},
});

// The cross-process fan-out subscription must never be opened eagerly at startup
// (on Workers that subscribe socket is request-scoped; binding it to request 1
// makes every later mutation's fan-out 500 with OutgoingFactory). It opens only
// while SSE handlers are live. Two transports:
//  - Shared: one ref-counted socket (Node; no per-request I/O constraint).
//  - Scoped: one dedicated socket PER handler, bound to its own request context
//    (Workers) — closing one stream never affects another's.
describe("lazy cross-process fan-out — shared path (no subscribeScoped)", () => {
  let kv: KVAdapter;
  let subSpy: ReturnType<typeof vi.spyOn>;
  let unsubSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await clearAllSubscriptions();
    kv = createMemoryKV();
    // Force the shared path by removing scoped support.
    (kv as { subscribeScoped?: unknown }).subscribeScoped = undefined;
    await kv.connect();
    subSpy = vi.spyOn(kv, "subscribe");
    unsubSpy = vi.spyOn(kv, "unsubscribe");
    setGlobalKV(kv);
  });

  afterEach(async () => {
    await clearAllSubscriptions();
    clearGlobalKV();
    vi.restoreAllMocks();
  });

  it("does not subscribe at init when there are no SSE handlers", async () => {
    await initializeEventSubscription();
    expect(subSpy).not.toHaveBeenCalled();
  });

  it("subscribes on the first handler and unsubscribes on the last", async () => {
    registerHandler("h1", fakeWriter());
    await vi.waitFor(() => expect(subSpy).toHaveBeenCalled());
    const channels = subSpy.mock.calls.map((c) => c[0]);
    expect(channels).toContain("covara:events");
    expect(channels).toContain("covara:aggregate");

    subSpy.mockClear();
    registerHandler("h2", fakeWriter());
    await new Promise((r) => setTimeout(r, 10));
    expect(subSpy).not.toHaveBeenCalled(); // ref-counted; one shared socket

    await unregisterHandler("h1");
    expect(unsubSpy).not.toHaveBeenCalled();

    await unregisterHandler("h2");
    await vi.waitFor(() => expect(unsubSpy).toHaveBeenCalled());
  });
});

describe("lazy cross-process fan-out — scoped path (Workers)", () => {
  let kv: KVAdapter;
  let scopedSpy: ReturnType<typeof vi.spyOn>;
  let closeSpies: ReturnType<typeof vi.fn>[] = [];

  beforeEach(async () => {
    await clearAllSubscriptions();
    closeSpies = [];
    kv = createMemoryKV();
    await kv.connect();
    const original = kv.subscribeScoped!.bind(kv);
    scopedSpy = vi
      .spyOn(kv, "subscribeScoped")
      .mockImplementation(async (channels, cb) => {
        const handle = await original(channels, cb);
        const closeSpy = vi.fn(() => handle.close());
        closeSpies.push(closeSpy);
        return { close: closeSpy } as ScopedSubscription;
      });
    setGlobalKV(kv);
  });

  afterEach(async () => {
    await clearAllSubscriptions();
    clearGlobalKV();
    vi.restoreAllMocks();
  });

  it("opens no socket at init", async () => {
    await initializeEventSubscription();
    expect(scopedSpy).not.toHaveBeenCalled();
  });

  it("opens ONE dedicated socket per handler (both channels)", async () => {
    registerHandler("h1", fakeWriter());
    await vi.waitFor(() => expect(scopedSpy).toHaveBeenCalledTimes(1));
    expect(scopedSpy.mock.calls[0][0]).toEqual(["covara:events", "covara:aggregate"]);

    registerHandler("h2", fakeWriter());
    await vi.waitFor(() => expect(scopedSpy).toHaveBeenCalledTimes(2));
  });

  it("closing one handler's socket never touches another's (bulletproof)", async () => {
    registerHandler("h1", fakeWriter());
    registerHandler("h2", fakeWriter());
    await vi.waitFor(() => expect(scopedSpy).toHaveBeenCalledTimes(2));

    expect(closeSpies).toHaveLength(2);

    // Close h1: exactly one socket closes, the other stays open.
    await unregisterHandler("h1");
    await vi.waitFor(() =>
      expect(closeSpies.filter((s) => s.mock.calls.length > 0)).toHaveLength(1)
    );

    // h2's socket is still open — its stream keeps receiving fan-out.
    await unregisterHandler("h2");
    await vi.waitFor(() =>
      expect(closeSpies.filter((s) => s.mock.calls.length > 0)).toHaveLength(2)
    );
  });
});
