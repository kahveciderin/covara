import { describe, it, expect, vi, beforeEach } from "vitest";

const { clients, FakeRedis, state } = vi.hoisted(() => {
  const clients: any[] = [];
  const state = { unreachable: false, subscribeFailures: 0, subscribeCalls: 0, failure: null as string | null, commands: 0 };
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
      state.subscribeCalls++;
      if (state.subscribeFailures > 0) {
        state.subscribeFailures--;
        throw new Error("Connection is closed.");
      }
      return 1;
    }
    async psubscribe() {
      return this.subscribe();
    }
    async get() {
      state.commands++;
      if (state.failure) throw new Error(state.failure);
      return "v";
    }
    multi() {
      const multi = {
        set: () => multi,
        exec: async () => {
          state.commands++;
          if (state.failure) throw new Error(state.failure);
          return [[null, "OK"]];
        },
      };
      return multi;
    }
  }
  return { clients, FakeRedis, state };
});

vi.mock("ioredis", () => ({ default: FakeRedis }));

import { createKV, createRedisKV } from "@/kv";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

beforeEach(() => {
  clients.length = 0;
  state.unreachable = false;
  state.subscribeFailures = 0;
  state.subscribeCalls = 0;
  state.failure = null;
  state.commands = 0;
});

describe("Redis KV fails fast after a command timeout", () => {
  const TIMEOUT = "Command timed out";
  let logs: LogRecord[];
  let previous: ReturnType<typeof getLogger>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    logs = [];
    previous = getLogger();
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    return () => {
      setLogger(previous);
      vi.useRealTimers();
    };
  });

  const store = async (options?: { failFastMs?: number }) => {
    const kv = createRedisKV(new FakeRedis({ lazyConnect: true }) as any, "", options);
    await kv.connect();
    return kv;
  };

  it("later commands fail without reaching Redis until the interval passes", async () => {
    const kv = await store();
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    for (let i = 0; i < 5; i++) await expect(kv.get("k")).rejects.toThrow(/failing fast/);
    expect(state.commands).toBe(1);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("one probe after the interval; a timed-out probe opens it again", async () => {
    const kv = await store({ failFastMs: 1000 });
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    vi.advanceTimersByTime(1001);
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    expect(state.commands).toBe(2);
    await expect(kv.get("k")).rejects.toThrow(/failing fast/);
    expect(state.commands).toBe(2);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("while a probe is in flight other commands still fail fast", async () => {
    const kv = await store({ failFastMs: 1000 });
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    vi.advanceTimersByTime(1001);
    state.failure = null;
    const probe = kv.get("k");
    await expect(kv.get("k")).rejects.toThrow(/failing fast/);
    await expect(probe).resolves.toBe("v");
  });

  it("an answered probe closes it", async () => {
    const kv = await store({ failFastMs: 1000 });
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    state.failure = null;
    vi.advanceTimersByTime(1001);
    await expect(kv.get("k")).resolves.toBe("v");
    await expect(kv.get("k")).resolves.toBe("v");
    expect(state.commands).toBe(3);
    expect(logs.some((l) => l.level === "info" && /answering again/.test(l.msg))).toBe(true);
  });

  it("covers transactions", async () => {
    const kv = await store();
    state.failure = TIMEOUT;
    await expect(kv.multi().set("a", "b").exec()).rejects.toThrow(TIMEOUT);
    await expect(kv.multi().set("a", "b").exec()).rejects.toThrow(/failing fast/);
    await expect(kv.get("k")).rejects.toThrow(/failing fast/);
    expect(state.commands).toBe(1);
  });

  it("other errors don't open it", async () => {
    const kv = await store();
    state.failure = "Connection is closed.";
    await expect(kv.get("k")).rejects.toThrow("Connection is closed.");
    await expect(kv.get("k")).rejects.toThrow("Connection is closed.");
    expect(state.commands).toBe(2);
  });

  it("failFastMs 0 turns it off", async () => {
    const kv = await store({ failFastMs: 0 });
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    expect(state.commands).toBe(2);
  });

  it("is configured from RedisConfig", async () => {
    const kv = await createKV({ type: "redis", redis: { url: "redis://example", failFastMs: 0 } });
    state.failure = TIMEOUT;
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
    await expect(kv.get("k")).rejects.toThrow(TIMEOUT);
  });
});

describe("Redis KV pub/sub", () => {
  it.each(["subscribe", "psubscribe"] as const)("%s sends the command again after a failed attempt", async (method) => {
    const kv = createRedisKV(new FakeRedis({ lazyConnect: true }) as any);
    await kv.connect();
    state.subscribeFailures = 1;
    await expect(kv[method]("c", () => {})).rejects.toThrow();
    await expect(kv[method]("c", () => {})).resolves.toBeUndefined();
    expect(state.subscribeCalls).toBe(2);
    await kv[method]("c", () => {});
    expect(state.subscribeCalls).toBe(2);
  });
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

describe("Redis KV from config survives an outage", () => {
  it("keeps reconnecting after maxRetries, which only bounds retries per command", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example", maxRetries: 2 } });
    const { options } = clients[0];
    expect(options.maxRetriesPerRequest).toBe(2);
    for (const attempt of [1, 3, 50, 10_000]) expect(options.retryStrategy(attempt)).toBeGreaterThan(0);
    expect(options.retryStrategy(10_000)).toBeLessThanOrEqual(2000);
  });

  it("times commands out after 5 s by default", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example" } });
    expect(clients[0].options.commandTimeout).toBe(5000);
  });

  it("takes a command timeout, and 0 turns it off", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example", commandTimeoutMs: 1500 } });
    expect(clients[0].options.commandTimeout).toBe(1500);
    await createKV({ type: "redis", redis: { host: "example", commandTimeoutMs: 0 } });
    expect(clients[1].options).not.toHaveProperty("commandTimeout");
  });

  it("passes the offline queue switch", async () => {
    await createKV({ type: "redis", redis: { url: "redis://example", offlineQueue: false } });
    expect(clients[0].options.enableOfflineQueue).toBe(false);
    await createKV({ type: "redis", redis: { url: "redis://example" } });
    expect(clients[1].options).not.toHaveProperty("enableOfflineQueue");
  });

  it("logs client errors once per outage, on the subscriber too", async () => {
    const logs: LogRecord[] = [];
    const previous = getLogger();
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    try {
      const kv = await createKV({ type: "redis", redis: { url: "redis://example" } });
      await kv.subscribe("c", () => {});
      const [main, sub] = clients;
      const emit = (client: any, event: string, ...args: unknown[]) =>
        (client.listeners.get(event) ?? []).forEach((fn: any) => fn(...args));
      emit(main, "error", new Error("ECONNREFUSED"));
      emit(main, "error", new Error("ECONNREFUSED"));
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
      emit(main, "ready");
      emit(main, "error", new Error("ETIMEDOUT"));
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
      emit(sub, "error", new Error("ECONNREFUSED"));
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(3);
    } finally {
      setLogger(previous);
    }
  });
});
