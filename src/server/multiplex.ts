import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { createSSEStream, type SSEWriter } from "@/server/sse";
import { getUser } from "@/server/context";
import { readJsonBody } from "@/server/request";
import { getResourceNameByPath } from "@/ui/schema-registry";
import { getGlobalKV, hasGlobalKV, type KVAdapter } from "@/kv/types";
import {
  getSubscribeDispatcher,
  type SubscriptionSink,
  type SubscribeHandle,
} from "@/resource/mux-registry";

export interface MultiplexConfig {
  // Max logical channels a single shared stream may hold. Defense against one
  // connection opening unbounded subscriptions; per-resource per-user/IP limits
  // still apply on top. Default 200.
  maxChannelsPerConnection?: number;
  // Heartbeat comment interval for the shared stream. Default 20000ms.
  heartbeatMs?: number;
  // Outbound buffer for the shared stream. Larger than a single subscription's
  // since it fans many channels; on overflow the stream closes and the client
  // reconnects + replays every channel (catchup redelivers). Default 262144.
  maxQueueBytes?: number;
}

interface MuxChannel {
  handle: SubscribeHandle | null;
  closed: boolean;
}

interface MuxConnection {
  writer: SSEWriter;
  userId: string;
  // Includes channels whose start is still pending in the stream's request.
  channels: Map<string, MuxChannel>;
  // Run `task` inside the request that owns the stream. See createStreamExecutor.
  run(task: () => Promise<void>): Promise<void>;
}

// Process-local registry of open shared streams. A control POST must land on the
// same process that holds the stream; if it doesn't (multi-isolate), the lookup
// misses and we return 409 so the client falls back to a legacy per-subscription
// connection for that channel.
const muxConnections = new Map<string, MuxConnection>();

// Exported for tests / diagnostics.
export const getMuxConnectionCount = (): number => muxConnections.size;

const muxFrame = (channelId: string, name: string, data: unknown): string =>
  `event: mux\ndata: ${JSON.stringify({ c: channelId, n: name, d: data })}\n\n`;

// A sink that frames every event with its channel id so N logical subscriptions
// share one physical stream. Mutation-driven events flow through `renderer`;
// lifecycle frames (connected/error/aggregate) are written directly.
const channelSink = (writer: SSEWriter, channelId: string): SubscriptionSink => ({
  writer,
  renderer: (event) => muxFrame(channelId, "message", event),
  writeConnected: (seq) => writer.write(muxFrame(channelId, "connected", { seq })),
  writeError: (message) => writer.write(muxFrame(channelId, "error", { error: message })),
  writeAggregate: (data, seq) => writer.write(muxFrame(channelId, "aggregate", { data, seq })),
});

const DRAIN_FALLBACK_MS = 1000;

const muxControlChannel = (cid: string): string => `covara:mux:${cid}`;

type ScopedKV = KVAdapter & { subscribeScoped: NonNullable<KVAdapter["subscribeScoped"]> };

const scopedKV = (): ScopedKV | null => {
  const kv = hasGlobalKV() ? getGlobalKV() : null;
  return kv && typeof kv.subscribeScoped === "function" ? (kv as ScopedKV) : null;
};

// Control POSTs are separate requests from the stream. On Workers only the
// stream's own request may write the stream or open a channel's fan-out socket
// (anything a POST opens dies with the POST), so channel start/stop is queued
// and drained from inside the stream's request: woken by a doorbell published
// on the stream's own scoped socket, with a timer in the stream's request as a
// fallback. Without a scoped-socket KV (Node: no KV, or Redis) there is no such
// constraint and tasks run directly in the control request.
const createStreamExecutor = (cid: string) => {
  const kv = scopedKV();
  if (!kv) {
    return { run: async (task: () => Promise<void>) => task(), drain: async () => {}, close: () => {} };
  }

  const queue: (() => Promise<void>)[] = [];
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (let task = queue.shift(); task; task = queue.shift()) {
        try {
          await task();
        } catch {
          // one channel failing to start must not stall the others
        }
      }
    } finally {
      draining = false;
    }
  };

  const doorbell = kv
    .subscribeScoped([muxControlChannel(cid)], () => void drain())
    .then(
      (sub) => {
        void drain();
        return sub;
      },
      () => null
    );
  const fallback = setInterval(() => void drain(), DRAIN_FALLBACK_MS);

  return {
    run: async (task: () => Promise<void>) => {
      queue.push(task);
      try {
        await kv.publish(muxControlChannel(cid), "");
      } catch {
        // the fallback timer drains it
      }
    },
    drain,
    close: () => {
      clearInterval(fallback);
      void doorbell.then((sub) => sub?.close()).catch(() => {});
    },
  };
};

const problem = (status: number, title: string, detail: string, code?: string) => ({
  type: "/__covara/problems/multiplex",
  title,
  status,
  detail,
  ...(code ? { code } : {}),
});

interface SubscribeBody {
  channelId?: string;
  resource?: string;
  kind?: "resource" | "aggregate";
  filter?: string;
  include?: string;
  resumeFrom?: number;
  skipExisting?: boolean;
  knownIds?: string[];
  aggregate?: Record<string, unknown>;
}

export const createMultiplexRouter = (config: MultiplexConfig = {}): Hono => {
  const router = new Hono();
  const maxChannels = config.maxChannelsPerConnection ?? 200;
  const heartbeatMs = config.heartbeatMs ?? 20000;
  const maxQueueBytes = config.maxQueueBytes ?? 262144;

  // Open the single shared SSE stream. The server mints the connection id and
  // sends it in a `ready` event; the client then targets control POSTs at it.
  router.get("/", async (c) => {
    const userId = getUser(c)?.id ?? "anonymous";
    const cid = uuidv4();

    const { writer, response } = createSSEStream({
      signal: c.req.raw.signal,
      maxQueueBytes,
    });

    const executor = createStreamExecutor(cid);
    const connection: MuxConnection = {
      writer,
      userId,
      channels: new Map(),
      run: executor.run,
    };
    muxConnections.set(cid, connection);

    // Flush `ready` immediately — the client only needs the connection id to
    // start subscribing. Do NOT block the first byte on a KV/DO read (e.g.
    // changelog sequence): on Workers a slow store read here would leave the
    // stream hung at 0 bytes, so no channel ever subscribes and nothing updates.
    writer.write(`event: ready\ndata: ${JSON.stringify({ cid })}\n\n`);

    const heartbeat = setInterval(() => {
      if (writer.closed) {
        clearInterval(heartbeat);
        return;
      }
      writer.write(`: ping ${Date.now()}\n\n`);
    }, heartbeatMs);

    writer.onClose(() => {
      clearInterval(heartbeat);
      muxConnections.delete(cid);
      const channels = Array.from(connection.channels.values());
      connection.channels.clear();
      for (const channel of channels) {
        channel.closed = true;
        if (channel.handle) void channel.handle.close();
      }
      // Pending starts see the closed stream and release their reserved slots.
      void executor.drain().finally(executor.close);
    });

    return response;
  });

  router.post("/:cid/subscribe", async (c) => {
    const cid = c.req.param("cid");
    const connection = muxConnections.get(cid);
    if (!connection) {
      return c.json(
        problem(409, "Stream not found", "The multiplex stream is not open on this server", "stream_not_found"),
        409
      );
    }

    const userId = getUser(c)?.id ?? "anonymous";
    if (connection.userId !== userId) {
      return c.json(problem(403, "Forbidden", "Stream belongs to a different user"), 403);
    }

    const body = (await readJsonBody(c)) as SubscribeBody;
    const channelId = body?.channelId;
    const resource = body?.resource;
    if (!channelId || !resource) {
      return c.json(problem(400, "Bad request", "channelId and resource are required"), 400);
    }

    if (connection.channels.has(channelId)) {
      return c.json(problem(409, "Channel exists", `Channel ${channelId} is already subscribed`), 409);
    }
    if (connection.channels.size >= maxChannels) {
      return c.json(
        problem(429, "Too many channels", `Maximum ${maxChannels} channels per connection`),
        429
      );
    }

    const resourceName = getResourceNameByPath(resource);
    const dispatcher = resourceName ? getSubscribeDispatcher(resourceName) : undefined;
    if (!dispatcher) {
      return c.json(problem(404, "Unknown resource", `No subscribable resource at ${resource}`), 404);
    }

    const result = await dispatcher({
      c,
      kind: body.kind === "aggregate" ? "aggregate" : "resource",
      params: {
        filter: body.filter,
        include: body.include,
        resumeFrom: body.resumeFrom,
        skipExisting: body.skipExisting,
        knownIds: body.knownIds,
        aggregateQuery: body.aggregate,
      },
    });

    if (!result.ok) {
      return c.json(problem(result.status, "Subscription failed", result.detail), result.status as never);
    }

    // Re-check after the dispatcher's await: a concurrent subscribe may have
    // claimed the id or filled the connection, or the stream may have closed.
    if (connection.writer.closed) {
      result.cancel();
      return c.json(problem(409, "Stream closed", "The stream closed before the subscription completed", "stream_not_found"), 409);
    }
    if (connection.channels.has(channelId)) {
      result.cancel();
      return c.json(problem(409, "Channel exists", `Channel ${channelId} is already subscribed`), 409);
    }
    if (connection.channels.size >= maxChannels) {
      result.cancel();
      return c.json(
        problem(429, "Too many channels", `Maximum ${maxChannels} channels per connection`),
        429
      );
    }

    // The channel id is claimed now (before the start runs) so a duplicate or an
    // over-limit subscribe is rejected even while this one is pending.
    const channel: MuxChannel = { handle: null, closed: false };
    connection.channels.set(channelId, channel);
    let startError: string | null = null;

    await connection.run(async () => {
      if (channel.closed || connection.writer.closed) {
        result.cancel();
        return;
      }
      try {
        channel.handle = await result.start(channelSink(connection.writer, channelId));
      } catch (error) {
        startError = error instanceof Error ? error.message : "Failed to start subscription";
        if (connection.channels.get(channelId) === channel) connection.channels.delete(channelId);
        return;
      }
      // Unsubscribed or the stream closed while the start ran: tear it back down.
      if (channel.closed || connection.writer.closed) await channel.handle.close();
    });

    // Only observable when the start ran inline (no scoped KV); otherwise the
    // outcome is reported on the channel itself (connected / error frames).
    if (startError !== null) {
      return c.json(problem(500, "Subscription failed", startError), 500);
    }
    if (connection.writer.closed) {
      return c.json(problem(409, "Stream closed", "The stream closed before the subscription completed", "stream_not_found"), 409);
    }

    return c.json({ ok: true, channelId });
  });

  router.post("/:cid/unsubscribe", async (c) => {
    const cid = c.req.param("cid");
    const connection = muxConnections.get(cid);
    if (!connection) {
      return c.json({ ok: true });
    }
    const userId = getUser(c)?.id ?? "anonymous";
    if (connection.userId !== userId) {
      return c.json(problem(403, "Forbidden", "Stream belongs to a different user"), 403);
    }
    const body = (await readJsonBody(c)) as { channelId?: string };
    const channelId = body?.channelId;
    const channel = channelId ? connection.channels.get(channelId) : undefined;
    if (channelId && channel) {
      connection.channels.delete(channelId);
      channel.closed = true;
      await connection.run(async () => {
        if (channel.handle) await channel.handle.close();
      });
    }
    return c.json({ ok: true });
  });

  return router;
};
