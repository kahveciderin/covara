// Client-side SSE connection multiplexing.
//
// All live subscriptions on a transport share ONE physical SSE stream instead of
// opening a browser connection each. `createEventSource` returns a MuxChannel that
// looks like an EventSource to the subscription managers (addEventListener /
// onerror / close) but is really a demultiplexed channel of the shared stream.
//
// If the server doesn't expose the multiplex endpoint (older server, disabled, or
// a multi-isolate deployment where the control POST can't reach the stream's
// process), the channel transparently falls back to a real per-subscription
// EventSource — so behavior is always correct, just without connection sharing.

const STREAM_PATH = "/__covara/stream";
const MAX_OPEN_ATTEMPTS = 3;
// If `ready` doesn't arrive within this window, the open is treated as failed
// (retry, then fall back) — prevents a slow/hung stream from leaving channels
// stuck with no events and no error forever.
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
// If no bytes (event OR heartbeat) arrive for this long after connecting, the
// stream is considered dead and reconnected — catches half-open connections
// where `reader.read()` never resolves or rejects. Must exceed the server
// heartbeat (default 20s).
const DEFAULT_STALL_TIMEOUT_MS = 50000;

export interface SharedSSEDeps {
  // Build an absolute URL for a path relative to the transport base.
  buildUrl: (path: string) => string;
  // Current request headers (auth etc.).
  getHeaders: () => Record<string, string>;
  credentials?: RequestCredentials;
  // Real per-subscription EventSource, used for fallback.
  createNativeEventSource: (path: string, params?: Record<string, string>) => EventSource;
  // Injectable for tests / non-browser runtimes.
  fetchImpl?: typeof fetch;
  // Override timeouts / backoff (mainly for tests).
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  backoff?: (attempt: number) => number;
}

type ProxyListener = (event: { data: string }) => void;

interface ParsedPath {
  resource: string;
  kind: "resource" | "aggregate";
}

const parsePath = (path: string): ParsedPath => {
  if (path.endsWith("/aggregate/subscribe")) {
    return { resource: path.slice(0, -"/aggregate/subscribe".length), kind: "aggregate" };
  }
  if (path.endsWith("/subscribe")) {
    return { resource: path.slice(0, -"/subscribe".length), kind: "resource" };
  }
  return { resource: path, kind: "resource" };
};

const backoff = (attempt: number): number =>
  Math.min(1000 * 2 ** attempt, 15000) * (0.5 + Math.random() * 0.5);

// EventSource-shaped channel over the shared stream. Implements just the surface
// the subscription managers use.
export class MuxChannel {
  onerror: ((ev?: unknown) => void) | null = null;
  readyState = 0;
  serverSubscribed = false;
  closedByUser = false;

  private listeners = new Map<string, Set<ProxyListener>>();
  private fallback: EventSource | null = null;

  constructor(
    readonly channelId: string,
    readonly body: Record<string, unknown>,
    private readonly conn: SharedSSEConnection,
    private readonly path: string,
    private readonly params: Record<string, string> | undefined
  ) {}

  addEventListener(type: string, cb: ProxyListener): void {
    if (this.fallback) {
      this.fallback.addEventListener(type, cb as unknown as EventListener);
      return;
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: ProxyListener): void {
    if (this.fallback) {
      this.fallback.removeEventListener(type, cb as unknown as EventListener);
      return;
    }
    this.listeners.get(type)?.delete(cb);
  }

  // Called by the shared connection for a demultiplexed frame on this channel.
  dispatch(type: string, data: string): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of set) {
      try {
        cb({ data });
      } catch {
        // a listener throwing must not break demux for other channels
      }
    }
  }

  emitError(): void {
    this.readyState = 2;
    try {
      this.onerror?.();
    } catch {
      // ignore
    }
  }

  // Switch this channel to a real per-subscription EventSource. Idempotent.
  toFallback(): void {
    if (this.fallback || this.closedByUser) return;
    let es: EventSource;
    try {
      es = this.conn.deps.createNativeEventSource(this.path, this.params);
    } catch {
      // No EventSource available at all — surface as a channel error.
      this.emitError();
      return;
    }
    this.fallback = es;
    for (const [type, set] of this.listeners) {
      for (const cb of set) es.addEventListener(type, cb as unknown as EventListener);
    }
    es.onerror = (ev) => {
      try {
        this.onerror?.(ev);
      } catch {
        // ignore
      }
    };
    this.listeners.clear();
    this.readyState = 1;
  }

  close(): void {
    this.closedByUser = true;
    this.readyState = 2;
    if (this.fallback) {
      this.fallback.close();
      this.fallback = null;
      return;
    }
    this.conn.closeChannel(this.channelId);
  }
}

export class SharedSSEConnection {
  private state: "idle" | "connecting" | "ready" | "unavailable" = "idle";
  private cid: string | null = null;
  private channels = new Map<string, MuxChannel>();
  private abort: AbortController | null = null;
  private attempts = 0;
  private counter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly deps: SharedSSEDeps) {}

  private get connectTimeoutMs(): number {
    return this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private get stallTimeoutMs(): number {
    return this.deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // Reset on every received chunk; fires only if the stream goes silent past the
  // heartbeat window (a dead/half-open connection). Aborting makes pump() exit
  // and reconnect.
  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      try {
        this.abort?.abort();
      } catch {
        // ignore
      }
    }, this.stallTimeoutMs);
  }

  private get fetchImpl(): typeof fetch | undefined {
    return this.deps.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  }

  openChannel(path: string, params?: Record<string, string>): MuxChannel {
    const { resource, kind } = parsePath(path);
    const channelId = `ch${++this.counter}`;
    const body: Record<string, unknown> =
      kind === "aggregate"
        ? { resource, kind, filter: params?.filter, aggregate: params ?? {} }
        : {
            resource,
            kind,
            filter: params?.filter,
            include: params?.include,
            resumeFrom: params?.resumeFrom ? Number(params.resumeFrom) : undefined,
            skipExisting: params?.skipExisting === "true",
            knownIds: params?.knownIds ? params.knownIds.split(",") : undefined,
          };

    const channel = new MuxChannel(channelId, body, this, path, params);
    this.channels.set(channelId, channel);

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.fetchImpl) {
      // No fetch (non-browser) — go straight to the native path.
      queueMicrotask(() => channel.toFallback());
      return channel;
    }

    if (this.state === "unavailable") {
      // Defer so the caller can attach listeners/onerror first.
      queueMicrotask(() => channel.toFallback());
    } else if (this.state === "ready") {
      void this.sendSubscribe(channel);
    } else {
      this.ensureStream();
    }

    return channel;
  }

  closeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    if (this.state === "ready" && this.cid && channel.serverSubscribed) {
      void this.sendControl("unsubscribe", { channelId });
    }
    this.scheduleIdleClose();
  }

  private scheduleIdleClose(): void {
    if (this.channels.size > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.channels.size === 0) this.teardownStream();
    }, 250);
  }

  private ensureStream(): void {
    if (this.state === "connecting" || this.state === "ready") return;
    if (!this.fetchImpl) {
      this.markUnavailable();
      return;
    }
    this.state = "connecting";
    // Bound the open→ready window: abort if the server is slow/hung so the fetch
    // (or pump) rejects and we retry/fall back instead of hanging forever.
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.state !== "connecting") return;
      try {
        this.abort?.abort();
      } catch {
        // ignore
      }
    }, this.connectTimeoutMs);
    void this.openStream();
  }

  private async openStream(): Promise<void> {
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) {
      this.markUnavailable();
      return;
    }
    const url = this.deps.buildUrl(STREAM_PATH);
    const abort = new AbortController();
    this.abort = abort;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.deps.getHeaders() },
        credentials: this.deps.credentials,
        signal: abort.signal,
      });
    } catch {
      this.onOpenFailure();
      return;
    }

    // Endpoint absent → multiplexing not supported by this server.
    if (res && (res.status === 404 || res.status === 501)) {
      this.markUnavailable();
      return;
    }
    if (!res || !res.ok || !res.body) {
      this.onOpenFailure();
      return;
    }

    // Attempts reset only once the stream actually becomes ready (in handleFrame),
    // not merely on a 200 — a server that accepts the connection but never sends
    // `ready` must still count toward the fallback threshold, not retry forever.
    void this.pump(res.body.getReader());
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    this.armStallTimer();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Any byte (event or heartbeat) proves the stream is alive.
        this.armStallTimer();
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.handleFrame(frame);
        }
      }
    } catch {
      // read error — treated as a drop below
    }
    this.clearStallTimer();
    // If we never reached "ready", this was a failed open (retry/fall back);
    // otherwise an established stream dropped (managers reconnect).
    if (this.state === "ready") {
      this.onStreamDropped();
    } else {
      this.onOpenFailure();
    }
  }

  private handleFrame(frame: string): void {
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = dataLines.join("\n");

    if (eventName === "ready") {
      let cid: string | undefined;
      try {
        cid = JSON.parse(data).cid;
      } catch {
        return;
      }
      if (!cid) return;
      this.cid = cid;
      this.state = "ready";
      this.attempts = 0;
      this.clearConnectTimer();
      for (const channel of this.channels.values()) {
        if (!channel.serverSubscribed && !channel.closedByUser) {
          void this.sendSubscribe(channel);
        }
      }
      return;
    }

    if (eventName === "mux") {
      let parsed: { c: string; n: string; d: unknown };
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const channel = this.channels.get(parsed.c);
      if (!channel) return;
      channel.dispatch(parsed.n, JSON.stringify(parsed.d));
    }
  }

  private async sendSubscribe(channel: MuxChannel): Promise<void> {
    if (this.state !== "ready" || !this.cid || channel.closedByUser) return;
    channel.serverSubscribed = true;
    let res: Response;
    try {
      res = await this.sendControl("subscribe", {
        channelId: channel.channelId,
        ...channel.body,
      });
    } catch {
      channel.serverSubscribed = false;
      return;
    }
    if (res.ok) return;
    channel.serverSubscribed = false;
    if (res.status === 409) {
      // The control POST reached a process that doesn't hold this stream. On a
      // multi-isolate deployment (e.g. Cloudflare Workers) the control channel
      // can't be guaranteed to hit the stream's isolate, so multiplexing isn't
      // viable here — retrying just loops forever (new stream on another isolate
      // → another 409 → nothing ever delivered). Fall back (stickily) to
      // per-subscription connections, which always work. On a single process
      // this never happens (the stream is always local).
      this.markUnavailable();
    } else {
      // 404 unknown resource / other: this channel can't be multiplexed here.
      channel.toFallback();
    }
  }

  private sendControl(op: "subscribe" | "unsubscribe", body: unknown): Promise<Response> {
    const fetchImpl = this.fetchImpl!;
    const url = this.deps.buildUrl(`${STREAM_PATH}/${this.cid}/${op}`);
    return fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.deps.getHeaders() },
      credentials: this.deps.credentials,
      body: JSON.stringify(body),
    });
  }

  private markUnavailable(): void {
    this.clearConnectTimer();
    this.clearStallTimer();
    this.state = "unavailable";
    this.cid = null;
    this.abort = null;
    for (const channel of this.channels.values()) channel.toFallback();
  }

  // Failure while the stream was never ready: retry a few times, then give up and
  // fall the whole client back to per-subscription connections.
  private onOpenFailure(): void {
    this.clearConnectTimer();
    this.clearStallTimer();
    this.state = "idle";
    this.cid = null;
    this.abort = null;
    this.attempts++;
    if (this.attempts >= MAX_OPEN_ATTEMPTS) {
      this.markUnavailable();
      return;
    }
    setTimeout(() => {
      if (this.channels.size > 0) this.ensureStream();
    }, (this.deps.backoff ?? backoff)(this.attempts));
  }

  // The established stream dropped. Notify every channel so its manager reconnects
  // (recreating channels with fresh resumeFrom); clear our channel map so those
  // stale proxies stop receiving frames. The next openChannel reopens the stream.
  private onStreamDropped(): void {
    if (this.state === "unavailable") return;
    this.clearConnectTimer();
    this.clearStallTimer();
    const channels = Array.from(this.channels.values());
    this.channels.clear();
    this.state = "idle";
    this.cid = null;
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        // ignore
      }
      this.abort = null;
    }
    for (const channel of channels) {
      channel.serverSubscribed = false;
      channel.emitError();
    }
  }

  private teardownStream(): void {
    this.clearConnectTimer();
    this.clearStallTimer();
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        // ignore
      }
      this.abort = null;
    }
    if (this.state !== "unavailable") {
      this.state = "idle";
    }
    this.cid = null;
  }
}
