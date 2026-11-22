import { describe, it, expect, vi, beforeEach } from "vitest";

const { clients, FakeRedis, state } = vi.hoisted(() => {
  const clients: any[] = [];
  const state = { unreachable: false };
  class FakeRedis {
    status = "wait";
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    options: any;
    url?: string;
    constructor(...args: any[]) {
      if (typeof args[0] === "string") this.url = args.shift();
      this.options = args[0] ?? {};
      clients.push(this);
      if (!this.options.lazyConnect) this.status = "connecting";
    }
    async connect() {
      if (["connecting", "connect", "ready"].includes(this.status)) {
        throw new Error("Redis is already connecting/connected");
      }
      if (state.unreachable) {
        this.status = "reconnecting";
        throw new Error("Connection is closed.");
      }
      this.status = "ready";
    }
    async quit() {
      this.status = "end";
      return "OK";
    }
    disconnect() {
      this.status = "end";
    }
    duplicate() {
      return new FakeRedis({ ...this.options });
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    }
    async subscribe() {
      return 1;
    }
  }
  return { clients, FakeRedis, state };
});

vi.mock("ioredis", () => ({ default: FakeRedis }));

import { createKV, createRedisKV } from "@/kv";

beforeEach(() => {
  clients.length = 0;
  state.unreachable = false;
});

describe("Redis KV connects", () => {
  it.each([{ url: "redis://example:6379/2" }, { host: "example", port: 6380 }])("from config %j", async (redis) => {
    const kv = await createKV({ type: "redis", redis });
    expect(kv.isConnected()).toBe(true);
  });

  it("applies retry options to a url", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example", maxRetries: 2, retryDelay: 70 } });
    const { options, url } = clients[0];
    expect(url).toBe("redis://example");
    expect(options.maxRetriesPerRequest).toBe(2);
    expect(options.retryStrategy(1)).toBe(70);
    expect(options.retryStrategy(3)).toBeNull();
  });

  it("does not override what the url carries", async () => {
    await createKV({ type: "redis", redis: { url: "rediss://user:pw@example:6390/4" } });
    for (const key of ["host", "port", "password", "db", "tls"]) expect(clients[0].options).not.toHaveProperty(key);
  });

  it("turns on TLS for a url when asked", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example", tls: true } });
    expect(clients[0].options.tls).toEqual({});
  });

  it.each(["connecting", "connect", "ready", "reconnecting"])("with a client that is already %s", async (status) => {
    const client = new FakeRedis();
    client.status = status;
    await expect(createRedisKV(client as any).connect()).resolves.toBeUndefined();
  });

  it("a lazy client", async () => {
    const client = new FakeRedis({ lazyConnect: true });
    await createRedisKV(client as any).connect();
    expect(client.status).toBe("ready");
  });

  it("twice without throwing", async () => {
    const kv = createRedisKV(new FakeRedis({ lazyConnect: true }) as any);
    await kv.connect();
    await expect(kv.connect()).resolves.toBeUndefined();
  });

  it.each([true, false])("its subscriber (lazyConnect %s)", async (lazyConnect) => {
    const kv = createRedisKV(new FakeRedis({ lazyConnect }) as any);
    await expect(kv.subscribe("c", () => {})).resolves.toBeUndefined();
  });

  it("stops the retry loop when the first connection fails", async () => {
    state.unreachable = true;
    await expect(createKV({ type: "redis", redis: { url: "redis://down" } })).rejects.toThrow("Connection is closed.");
    expect(clients[0].status).toBe("end");
  });
});
