import type { Context } from "hono";
import type { SSEWriter } from "@/server/sse";
import type { EventRenderer } from "./subscription";

// A sink abstracts HOW subscription output is framed onto a writer. The standalone
// /subscribe route uses a "raw" sink (one subscription per stream, native SSE event
// names). The multiplex endpoint uses a "channel" sink that wraps every frame with a
// channel id so many logical subscriptions share one physical SSE stream. The
// subscription core (in useResource) is written against this interface and is
// oblivious to which transport it is feeding.
export interface SubscriptionSink {
  readonly writer: SSEWriter;
  // Renderer applied to mutation-driven push events (added/changed/removed/…) via
  // registerHandler. Undefined = default JSON `data:` frame.
  readonly renderer?: EventRenderer;
  // Lifecycle frames written directly by the core (not routed through the fan-out).
  writeConnected(seq: number): void;
  writeError(message: string): void;
  writeAggregate(data: unknown, seq: number): void;
}

export interface MuxSubscribeParams {
  filter?: string;
  include?: string;
  resumeFrom?: number;
  skipExisting?: boolean;
  knownIds?: string[];
  // Raw aggregate query params (groupBy/count/sum/avg/min/max/having) for
  // kind === "aggregate".
  aggregateQuery?: Record<string, unknown>;
}

export interface SubscribeHandle {
  // Tear down this one logical subscription (unregister handler, remove
  // subscription record, clear its timers). Idempotent.
  close(): Promise<void>;
}

export interface SubscribeDispatchArgs {
  // Hono context of the control request — carries the authenticated user, IP, and
  // impersonation/admin-bypass markers used to resolve this channel's scope.
  c: Context;
  sink: SubscriptionSink;
  kind: "resource" | "aggregate";
  params: MuxSubscribeParams;
}

export type SubscribeDispatchResult =
  | { ok: true; handle: SubscribeHandle }
  | { ok: false; status: number; detail: string };

export type SubscribeDispatcher = (
  args: SubscribeDispatchArgs
) => Promise<SubscribeDispatchResult>;

// Registry of per-resource subscribe dispatchers, keyed by resource name. Populated
// by useResource so the central multiplex endpoint can start a subscription on any
// resource without re-entering its HTTP route.
const dispatchers = new Map<string, SubscribeDispatcher>();

export const registerSubscribeDispatcher = (
  resource: string,
  dispatcher: SubscribeDispatcher
): void => {
  dispatchers.set(resource, dispatcher);
};

export const getSubscribeDispatcher = (
  resource: string
): SubscribeDispatcher | undefined => dispatchers.get(resource);

export const clearSubscribeDispatchers = (): void => {
  dispatchers.clear();
};
