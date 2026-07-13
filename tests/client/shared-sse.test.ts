import { describe, it, expect, vi } from "vitest";
import { SharedSSEConnection } from "@/client/shared-sse";

const tick = (n = 3) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : setTimeout(step, 0));
    setTimeout(step, 0);
  });

const makeStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
  };
};

const fakeEventSource = () => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const es: any = {
    onerror: null,
    closed: false,
    addEventListener: (t: string, cb: any) => {
      let s = listeners.get(t);
      if (!s) listeners.set(t, (s = new Set()));
      s.add(cb);
    },
    removeEventListener: (t: string, cb: any) => listeners.get(t)?.delete(cb),
    close: () => {
      es.closed = true;
    },
    _emit: (t: string, data: string) => {
      for (const cb of listeners.get(t) ?? []) cb({ data });
    },
  };
  return es;
};

interface Harness {
  conn: SharedSSEConnection;
  stream: ReturnType<typeof makeStream>;
  controlCalls: { url: string; body: any }[];
  nativeCalls: { path: string; params?: Record<string, string> }[];
  nativeSources: ReturnType<typeof fakeEventSource>[];
}

const makeHarness = (opts: { streamStatus?: number } = {}): Harness => {
  const stream = makeStream();
  const controlCalls: { url: string; body: any }[] = [];
  const nativeCalls: { path: string; params?: Record<string, string> }[] = [];
  const nativeSources: ReturnType<typeof fakeEventSource>[] = [];

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/__covara/stream")) {
      if (opts.streamStatus && opts.streamStatus !== 200) {
        return new Response("", { status: opts.streamStatus });
      }
      return stream.response;
    }
    controlCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const conn = new SharedSSEConnection({
    buildUrl: (p) => `http://x${p}`,
    getHeaders: () => ({}),
    fetchImpl,
    createNativeEventSource: (path, params) => {
      nativeCalls.push({ path, params });
      const es = fakeEventSource();
      nativeSources.push(es);
      return es as unknown as EventSource;
    },
  });

  return { conn, stream, controlCalls, nativeCalls, nativeSources };
};

const ready = (cid = "cid-1") => `event: ready\ndata: ${JSON.stringify({ cid, seq: 0 })}\n\n`;
const mux = (c: string, n: string, d: unknown) =>
  `event: mux\ndata: ${JSON.stringify({ c, n, d })}\n\n`;

describe("SharedSSEConnection", () => {
  it("opens one stream and subscribes a channel, then demuxes its events", async () => {
    const h = makeHarness();
    const channel = h.conn.openChannel("/api/todos/subscribe", { filter: "done==false" });

    const messages: any[] = [];
    channel.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
    let connectedSeq: number | undefined;
    channel.addEventListener("connected", (e) => (connectedSeq = JSON.parse(e.data).seq));

    await tick();
    h.stream.push(ready());
    await tick();

    // A subscribe control POST was sent with the derived resource/params.
    expect(h.controlCalls.length).toBe(1);
    expect(h.controlCalls[0].url).toBe("http://x/__covara/stream/cid-1/subscribe");
    expect(h.controlCalls[0].body).toMatchObject({
      resource: "/api/todos",
      kind: "resource",
      filter: "done==false",
      channelId: channel.channelId,
    });

    // Server frames for this channel are demuxed to the channel's listeners.
    h.stream.push(mux(channel.channelId, "connected", { seq: 7 }));
    h.stream.push(mux(channel.channelId, "message", { type: "added", object: { id: "1" } }));
    await tick();

    expect(connectedSeq).toBe(7);
    expect(messages).toEqual([{ type: "added", object: { id: "1" } }]);
  });

  it("multiplexes two channels over one stream, routing by channel id", async () => {
    const h = makeHarness();
    const a = h.conn.openChannel("/api/todos/subscribe");
    const b = h.conn.openChannel("/api/notes/subscribe");
    const aMsgs: any[] = [];
    const bMsgs: any[] = [];
    a.addEventListener("message", (e) => aMsgs.push(JSON.parse(e.data)));
    b.addEventListener("message", (e) => bMsgs.push(JSON.parse(e.data)));

    await tick();
    h.stream.push(ready());
    await tick();

    // Only one physical stream fetch; two subscribe POSTs.
    expect(h.controlCalls.filter((c) => c.url.endsWith("/subscribe")).length).toBe(2);

    h.stream.push(mux(a.channelId, "message", { type: "added", object: { id: "a" } }));
    h.stream.push(mux(b.channelId, "message", { type: "added", object: { id: "b" } }));
    await tick();

    expect(aMsgs).toEqual([{ type: "added", object: { id: "a" } }]);
    expect(bMsgs).toEqual([{ type: "added", object: { id: "b" } }]);
  });

  it("derives aggregate channels from the path", async () => {
    const h = makeHarness();
    const channel = h.conn.openChannel("/api/todos/aggregate/subscribe", { count: "true" });
    await tick();
    h.stream.push(ready());
    await tick();

    expect(h.controlCalls[0].body).toMatchObject({
      resource: "/api/todos",
      kind: "aggregate",
    });
    expect(h.controlCalls[0].body.aggregate).toMatchObject({ count: "true" });
    channel.close();
  });

  it("sends an unsubscribe control message on close", async () => {
    const h = makeHarness();
    const channel = h.conn.openChannel("/api/todos/subscribe");
    await tick();
    h.stream.push(ready());
    await tick();

    channel.close();
    await tick();

    const unsub = h.controlCalls.find((c) => c.url.endsWith("/unsubscribe"));
    expect(unsub).toBeDefined();
    expect(unsub!.body.channelId).toBe(channel.channelId);
  });

  it("falls back to a native EventSource when the endpoint is absent (404)", async () => {
    const h = makeHarness({ streamStatus: 404 });
    const channel = h.conn.openChannel("/api/todos/subscribe", { filter: "x==1" });
    const messages: any[] = [];
    channel.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));

    await tick(6);

    expect(h.nativeCalls.length).toBe(1);
    expect(h.nativeCalls[0].path).toBe("/api/todos/subscribe");
    expect(h.nativeCalls[0].params).toMatchObject({ filter: "x==1" });

    // Events now flow through the native source, transparently.
    h.nativeSources[0]._emit("message", JSON.stringify({ type: "added", object: { id: "n" } }));
    expect(messages).toEqual([{ type: "added", object: { id: "n" } }]);
  });

  it("fires channel onerror when the shared stream drops", async () => {
    const h = makeHarness();
    const channel = h.conn.openChannel("/api/todos/subscribe");
    let errored = false;
    channel.onerror = () => {
      errored = true;
    };
    await tick();
    h.stream.push(ready());
    await tick();

    h.stream.close();
    await tick();

    expect(errored).toBe(true);
  });
});

// A ReadableStream that stays open and rejects its reader when the fetch signal
// aborts — mirrors how a real fetch body reacts to AbortController.abort().
const abortableStream = (): { fetchImpl: typeof fetch; pushes: ((s: string) => void)[]; streamFetches: () => number } => {
  const enc = new TextEncoder();
  const pushes: ((s: string) => void)[] = [];
  let count = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/__covara/stream")) {
      count++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          pushes.push((s) => controller.enqueue(enc.encode(s)));
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.error(new Error("aborted"));
            } catch {
              // already closed
            }
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, pushes, streamFetches: () => count };
};

describe("SharedSSEConnection — retry & stall robustness", () => {
  it("retries then falls back to native when the stream never becomes ready", async () => {
    const { fetchImpl, streamFetches } = abortableStream();
    const nativeCalls: string[] = [];
    const conn = new SharedSSEConnection({
      buildUrl: (p) => `http://x${p}`,
      getHeaders: () => ({}),
      fetchImpl,
      connectTimeoutMs: 10,
      backoff: () => 1,
      createNativeEventSource: (path) => {
        nativeCalls.push(path);
        return fakeEventSource() as unknown as EventSource;
      },
    });

    const channel = conn.openChannel("/api/todos/subscribe");
    channel.addEventListener("message", () => {});

    // Each open hangs (no `ready`) → connect timeout aborts → retry; after
    // MAX_OPEN_ATTEMPTS the channel falls back to a native EventSource. Never
    // leaves the channel stuck with no events and no error.
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(1), { timeout: 2000 });
    expect(streamFetches()).toBeGreaterThanOrEqual(3);
  });

  it("falls back to native (no infinite loop) when a control POST returns 409", async () => {
    // Multi-isolate (Workers): the stream opens fine but the subscribe control
    // POST hits a different isolate → 409 stream_not_found. This must fall back to
    // per-subscription connections, not retry forever (which delivered nothing).
    const stream = makeStream();
    let subscribeCalls = 0;
    const nativeCalls: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/__covara/stream")) return stream.response;
      if (url.includes("/subscribe")) {
        subscribeCalls++;
        return new Response(JSON.stringify({ code: "stream_not_found" }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new SharedSSEConnection({
      buildUrl: (p) => `http://x${p}`,
      getHeaders: () => ({}),
      fetchImpl,
      createNativeEventSource: (path) => {
        nativeCalls.push(path);
        return fakeEventSource() as unknown as EventSource;
      },
    });

    const channel = conn.openChannel("/api/todos/subscribe");
    channel.addEventListener("message", () => {});

    await tick();
    stream.push(ready());
    await tick();

    // Fell back to a native per-subscription connection after a single 409.
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(1), { timeout: 1000 });
    expect(subscribeCalls).toBe(1);

    // A second channel opened afterwards also goes straight to native (sticky).
    const channel2 = conn.openChannel("/api/notes/subscribe");
    channel2.addEventListener("message", () => {});
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(2), { timeout: 1000 });
    expect(subscribeCalls).toBe(1);
  });

  it("detects a stalled (silent) stream and errors the channel so it reconnects", async () => {
    const { fetchImpl, pushes } = abortableStream();
    const conn = new SharedSSEConnection({
      buildUrl: (p) => `http://x${p}`,
      getHeaders: () => ({}),
      fetchImpl,
      stallTimeoutMs: 20,
      createNativeEventSource: () => fakeEventSource() as unknown as EventSource,
    });

    const channel = conn.openChannel("/api/todos/subscribe");
    let errored = false;
    channel.onerror = () => {
      errored = true;
    };
    channel.addEventListener("message", () => {});

    await tick();
    pushes[0](ready()); // becomes ready, then goes silent (no heartbeats)
    await tick();

    // No data past the stall window → the connection is considered dead and the
    // channel errors, which drives the subscription manager to reconnect.
    await vi.waitFor(() => expect(errored).toBe(true), { timeout: 2000 });
  });
});
