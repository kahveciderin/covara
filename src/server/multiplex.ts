import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { createSSEStream, type SSEWriter } from "@/server/sse";
import { getUser } from "@/server/context";
import { readJsonBody } from "@/server/request";
import { changelog } from "@/resource/changelog";
import { getResourceNameByPath } from "@/ui/schema-registry";
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

interface MuxConnection {
  writer: SSEWriter;
  userId: string;
  channels: Map<string, SubscribeHandle>;
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

    const connection: MuxConnection = { writer, userId, channels: new Map() };
    muxConnections.set(cid, connection);

    const seq = await changelog.getCurrentSequence();
    writer.write(`event: ready\ndata: ${JSON.stringify({ cid, seq })}\n\n`);

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
      const handles = Array.from(connection.channels.values());
      connection.channels.clear();
      for (const handle of handles) void handle.close();
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

    const sink = channelSink(connection.writer, channelId);
    const result = await dispatcher({
      c,
      sink,
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

    // The stream may have closed while the dispatcher ran; if so, tear the new
    // channel back down instead of leaking it.
    if (writerClosed(connection)) {
      void result.handle.close();
      return c.json(problem(409, "Stream closed", "The stream closed before the subscription completed", "stream_not_found"), 409);
    }

    connection.channels.set(channelId, result.handle);
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
    if (channelId) {
      const handle = connection.channels.get(channelId);
      if (handle) {
        connection.channels.delete(channelId);
        await handle.close();
      }
    }
    return c.json({ ok: true });
  });

  return router;
};

const writerClosed = (connection: MuxConnection): boolean => connection.writer.closed;
