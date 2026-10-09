import { AsyncLocalStorage } from "node:async_hooks";
import type { KVAdapter, ScopedSubscription } from "@/kv/types";

// A Node model of Cloudflare Workers' per-request I/O ownership. Every simulated
// request runs inside its own context; I/O objects (SSE streams, subscribe
// sockets) are bound to the context that created them. A stream written from a
// different request's context, or a socket whose owning request already ended,
// behaves like it does on Workers: the write fails, the socket goes silent.
export interface RequestCtx {
  name: string;
  alive: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestCtx>();

export interface IoViolation {
  kind: "write" | "socket-close";
  owner: string;
  from: string;
}

export const ioViolations: IoViolation[] = [];

export const currentCtx = (): RequestCtx | undefined => requestContext.getStore();

export const ctxName = (): string => currentCtx()?.name ?? "<none>";

let counter = 0;

// Run a non-streaming request: its context dies as soon as the response is read.
export const inRequest = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const ctx: RequestCtx = { name: `${name}#${++counter}`, alive: true };
  try {
    return await requestContext.run(ctx, fn);
  } finally {
    ctx.alive = false;
  }
};

// Run a streaming request: its context stays alive until `end()` is called.
export const inStreamingRequest = async <T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; ctx: RequestCtx }> => {
  const ctx: RequestCtx = { name: `${name}#${++counter}`, alive: true };
  const result = await requestContext.run(ctx, fn);
  return { result, ctx };
};

export interface ScopedSocketRecord {
  openedIn: string;
  channels: string[];
  closedFrom?: string;
}

// Wrap a KV so each subscribeScoped socket is bound to the request context that
// opened it: messages are delivered inside that context and only while it is
// alive (a Workers socket dies with its request).
export const bindScopedSocketsToRequests = (kv: KVAdapter): ScopedSocketRecord[] => {
  const records: ScopedSocketRecord[] = [];
  const original = kv.subscribeScoped!.bind(kv);
  kv.subscribeScoped = async (channels, callback): Promise<ScopedSubscription> => {
    const owner = currentCtx();
    const record: ScopedSocketRecord = { openedIn: owner?.name ?? "<none>", channels };
    records.push(record);
    const handle = await original(channels, (message, channel) => {
      if (owner && !owner.alive) return;
      if (owner) {
        requestContext.run(owner, () => callback(message, channel));
      } else {
        callback(message, channel);
      }
    });
    return {
      close: async () => {
        record.closedFrom = ctxName();
        if (owner && currentCtx() && currentCtx() !== owner) {
          ioViolations.push({ kind: "socket-close", owner: owner.name, from: ctxName() });
        }
        await handle.close();
      },
    };
  };
  return records;
};
