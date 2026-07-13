import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryKV, MemoryKVStore } from "@/kv/memory";
import { createKV } from "@/kv";
import {
  CovaraKVDurableObject,
  createDurableObjectKV,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type WebSocketLike,
} from "@/kv/durable-object";
import type {
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  KVAdapter,
} from "@/kv/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDOStorage implements DurableObjectStorageLike {
  data = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.data.has(key)) return undefined;
    return structuredClone(this.data.get(key)) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key)) as T]));
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}

class FakeWebSocket implements WebSocketLike {
  peer: FakeWebSocket | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  private attachment: unknown;

  accept(): void {}

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    const peer = this.peer;
    if (!peer || peer.closed) throw new Error("peer closed");
    peer.emit("message", { data });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.emit("close", {});
    }
  }

  addEventListener(
    type: "message" | "close",
    handler: (event: { data?: unknown }) => void
  ): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const handler of this.listeners.get(type) ?? new Set()) {
      handler(event);
    }
  }
}

function FakeWebSocketPair(this: unknown): Record<string, WebSocketLike> {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.peer = server;
  server.peer = client;
  return { 0: client, 1: server };
}

class FakeDOState implements DurableObjectStateLike {
  storage = new FakeDOStorage();
  private sockets = new Map<WebSocketLike, string[]>();

  acceptWebSocket(ws: WebSocketLike, tags: string[] = []): void {
    this.sockets.set(ws, tags);
    (ws as FakeWebSocket).addEventListener("close", () => {
      this.sockets.delete(ws);
    });
  }

  getWebSockets(tag?: string): WebSocketLike[] {
    return [...this.sockets.entries()]
      .filter(([, tags]) => tag === undefined || tags.includes(tag))
      .map(([ws]) => ws);
  }
}

class FakeNamespace implements DurableObjectNamespaceLike {
  states = new Map<string, FakeDOState>();
  private objects = new Map<string, CovaraKVDurableObject>();

  idFromName(name: string): unknown {
    return name;
  }

  get(id: unknown): DurableObjectStubLike {
    const name = String(id);
    let instance = this.objects.get(name);
    if (!instance) {
      const state = new FakeDOState();
      this.states.set(name, state);
      instance = new CovaraKVDurableObject(state);
      this.objects.set(name, instance);
    }
    const target = instance;
    return {
      fetch: (input, init) => target.fetch(new Request(input, init as RequestInit)),
    };
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
});

const runKVAdapterConformance = (
  name: string,
  makeAdapter: () => KVAdapter
) => {
  describe(`KV adapter conformance: ${name}`, () => {
    let kv: KVAdapter;

    beforeEach(async () => {
      kv = makeAdapter();
      await kv.connect();
      return async () => {
        await kv.disconnect();
      };
    });

    describe("strings", () => {
      it("sets and gets string values", async () => {
        await kv.set("k", "value");
        expect(await kv.get("k")).toBe("value");
        expect(await kv.get("missing")).toBeNull();
      });

      it("set nx only sets when key is missing", async () => {
        await kv.set("k", "first", { nx: true });
        await kv.set("k", "second", { nx: true });
        expect(await kv.get("k")).toBe("first");
      });

      it("set xx only sets when key exists", async () => {
        await kv.set("k", "first", { xx: true });
        expect(await kv.get("k")).toBeNull();
        await kv.set("k", "first");
        await kv.set("k", "second", { xx: true });
        expect(await kv.get("k")).toBe("second");
      });

      it("set with px expires the key", async () => {
        await kv.set("k", "value", { px: 30 });
        expect(await kv.get("k")).toBe("value");
        await sleep(60);
        expect(await kv.get("k")).toBeNull();
        expect(await kv.exists("k")).toBe(0);
      });

      it("set with ex sets a ttl", async () => {
        await kv.set("k", "value", { ex: 5 });
        const ttl = await kv.ttl("k");
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(5);
      });

      it("ttl returns -2 for missing and -1 for no expiry", async () => {
        expect(await kv.ttl("missing")).toBe(-2);
        await kv.set("k", "value");
        expect(await kv.ttl("k")).toBe(-1);
      });

      it("ttl returns -2 after expiry", async () => {
        await kv.set("k", "value", { px: 20 });
        await sleep(50);
        expect(await kv.ttl("k")).toBe(-2);
      });

      it("supports incr, incrBy and decr", async () => {
        expect(await kv.incr("counter")).toBe(1);
        expect(await kv.incrBy("counter", 5)).toBe(6);
        expect(await kv.decr("counter")).toBe(5);
        expect(await kv.get("counter")).toBe("5");
      });

      it("incr preserves an existing ttl", async () => {
        await kv.set("counter", "1", { ex: 100 });
        await kv.incr("counter");
        expect(await kv.ttl("counter")).toBeGreaterThan(0);
      });

      it("del and exists handle multiple keys", async () => {
        await kv.set("a", "1");
        await kv.set("b", "2");
        expect(await kv.exists("a", "b", "missing")).toBe(2);
        expect(await kv.del("a", "b", "missing")).toBe(2);
        expect(await kv.exists("a", "b")).toBe(0);
      });

      it("set overwrites a collection key", async () => {
        await kv.sadd("k", "member");
        await kv.set("k", "value");
        expect(await kv.get("k")).toBe("value");
        expect(await kv.smembers("k")).toEqual([]);
      });
    });

    describe("hashes", () => {
      it("hset returns 1 for new fields and 0 for overwrites", async () => {
        expect(await kv.hset("h", "f", "1")).toBe(1);
        expect(await kv.hset("h", "f", "2")).toBe(0);
        expect(await kv.hget("h", "f")).toBe("2");
        expect(await kv.hget("h", "missing")).toBeNull();
        expect(await kv.hget("missing", "f")).toBeNull();
      });

      it("hmset and hgetall round-trip", async () => {
        await kv.hmset("h", { a: "1", b: "2", c: "3" });
        expect(await kv.hgetall("h")).toEqual({ a: "1", b: "2", c: "3" });
        expect(await kv.hgetall("missing")).toEqual({});
      });

      it("hdel, hexists, hkeys and hlen behave consistently", async () => {
        await kv.hmset("h", { a: "1", b: "2", c: "3" });
        expect(await kv.hdel("h", "a", "missing")).toBe(1);
        expect(await kv.hdel("missing", "a")).toBe(0);
        expect(await kv.hexists("h", "b")).toBe(true);
        expect(await kv.hexists("h", "a")).toBe(false);
        expect((await kv.hkeys("h")).sort()).toEqual(["b", "c"]);
        expect(await kv.hlen("h")).toBe(2);
      });

      it("hset replaces a string key", async () => {
        await kv.set("k", "value");
        expect(await kv.hset("k", "f", "1")).toBe(1);
        expect(await kv.hget("k", "f")).toBe("1");
        expect(await kv.get("k")).toBeNull();
      });
    });

    describe("sets", () => {
      it("supports sadd, smembers, sismember, scard and srem", async () => {
        expect(await kv.sadd("s", "a", "b", "a")).toBe(2);
        expect(await kv.sadd("s", "b", "c")).toBe(1);
        expect((await kv.smembers("s")).sort()).toEqual(["a", "b", "c"]);
        expect(await kv.sismember("s", "a")).toBe(true);
        expect(await kv.sismember("s", "z")).toBe(false);
        expect(await kv.scard("s")).toBe(3);
        expect(await kv.srem("s", "a", "z")).toBe(1);
        expect(await kv.srem("missing", "a")).toBe(0);
        expect(await kv.scard("s")).toBe(2);
      });
    });

    describe("lists", () => {
      it("lpush and rpush keep redis ordering", async () => {
        expect(await kv.rpush("l", "a", "b")).toBe(2);
        expect(await kv.lpush("l", "c", "d")).toBe(4);
        expect(await kv.lrange("l", 0, -1)).toEqual(["d", "c", "a", "b"]);
      });

      it("lrange honors negative indices", async () => {
        await kv.rpush("l", "a", "b", "c", "d", "e");
        expect(await kv.lrange("l", 0, -1)).toEqual(["a", "b", "c", "d", "e"]);
        expect(await kv.lrange("l", 1, -2)).toEqual(["b", "c", "d"]);
        expect(await kv.lrange("l", -2, -1)).toEqual(["d", "e"]);
        expect(await kv.lrange("l", 5, 10)).toEqual([]);
        expect(await kv.lrange("l", 2, 1)).toEqual([]);
        expect(await kv.lrange("missing", 0, -1)).toEqual([]);
      });

      it("lpop and rpop return null on empty lists", async () => {
        await kv.rpush("l", "a", "b", "c");
        expect(await kv.lpop("l")).toBe("a");
        expect(await kv.rpop("l")).toBe("c");
        expect(await kv.llen("l")).toBe(1);
        expect(await kv.lpop("l")).toBe("b");
        expect(await kv.lpop("l")).toBeNull();
        expect(await kv.rpop("l")).toBeNull();
        expect(await kv.lpop("missing")).toBeNull();
      });

      it("ltrim keeps the requested range", async () => {
        await kv.rpush("l", "a", "b", "c", "d", "e");
        await kv.ltrim("l", 1, 3);
        expect(await kv.lrange("l", 0, -1)).toEqual(["b", "c", "d"]);
        expect(await kv.llen("l")).toBe(3);
        await kv.ltrim("l", 0, -2);
        expect(await kv.lrange("l", 0, -1)).toEqual(["b", "c"]);
        await kv.ltrim("l", 5, 10);
        expect(await kv.lrange("l", 0, -1)).toEqual([]);
        expect(await kv.llen("l")).toBe(0);
        await kv.rpush("l", "x");
        expect(await kv.lrange("l", 0, -1)).toEqual(["x"]);
      });

      it("stays consistent across interleaved pushes and pops", async () => {
        await kv.lpush("l", "b");
        await kv.lpush("l", "a");
        await kv.rpush("l", "c");
        expect(await kv.rpop("l")).toBe("c");
        await kv.rpush("l", "d");
        expect(await kv.lrange("l", 0, -1)).toEqual(["a", "b", "d"]);
        expect(await kv.llen("l")).toBe(3);
      });
    });

    describe("sorted sets", () => {
      it("zadd returns 1 for new members and 0 for updates", async () => {
        expect(await kv.zadd("z", 1, "a")).toBe(1);
        expect(await kv.zadd("z", 2, "a")).toBe(0);
        expect(await kv.zscore("z", "a")).toBe(2);
        expect(await kv.zscore("z", "missing")).toBeNull();
        expect(await kv.zscore("missing", "a")).toBeNull();
      });

      it("zrange orders by score and honors negative indices", async () => {
        await kv.zadd("z", 30, "c");
        await kv.zadd("z", 10, "a");
        await kv.zadd("z", 20, "b");
        expect(await kv.zrange("z", 0, -1)).toEqual(["a", "b", "c"]);
        expect(await kv.zrange("z", 1, 1)).toEqual(["b"]);
        expect(await kv.zrange("z", -2, -1)).toEqual(["b", "c"]);
      });

      it("zrangebyscore supports infinity bounds and limits", async () => {
        for (const [score, member] of [
          [1, "m1"],
          [2, "m2"],
          [3, "m3"],
          [4, "m4"],
          [5, "m5"],
        ] as Array<[number, string]>) {
          await kv.zadd("z", score, member);
        }
        expect(await kv.zrangebyscore("z", "-inf", "+inf")).toEqual([
          "m1",
          "m2",
          "m3",
          "m4",
          "m5",
        ]);
        expect(await kv.zrangebyscore("z", 2, 4)).toEqual(["m2", "m3", "m4"]);
        expect(
          await kv.zrangebyscore("z", "-inf", "+inf", {
            limit: { offset: 1, count: 2 },
          })
        ).toEqual(["m2", "m3"]);
        expect(await kv.zrangebyscore("z", 6, "+inf")).toEqual([]);
      });

      it("zcard and zrem behave consistently", async () => {
        await kv.zadd("z", 1, "a");
        await kv.zadd("z", 2, "b");
        expect(await kv.zcard("z")).toBe(2);
        expect(await kv.zrem("z", "a", "missing")).toBe(1);
        expect(await kv.zrem("missing", "a")).toBe(0);
        expect(await kv.zcard("z")).toBe(1);
      });

      it("zincrby creates and increments scores", async () => {
        expect(await kv.zincrby("z", 5, "a")).toBe(5);
        expect(await kv.zincrby("z", 3, "a")).toBe(8);
        await kv.zadd("z", 6, "b");
        expect(await kv.zrange("z", 0, -1)).toEqual(["b", "a"]);
      });
    });

    describe("keys and scan", () => {
      it("keys matches glob patterns", async () => {
        await kv.set("user:1", "a");
        await kv.set("user:2", "b");
        await kv.set("post:1", "c");
        await kv.hset("user:profile:1", "f", "v");
        expect((await kv.keys("*")).sort()).toEqual([
          "post:1",
          "user:1",
          "user:2",
          "user:profile:1",
        ]);
        expect((await kv.keys("user:*")).sort()).toEqual([
          "user:1",
          "user:2",
          "user:profile:1",
        ]);
        expect((await kv.keys("user:?")).sort()).toEqual(["user:1", "user:2"]);
      });

      it("keys spans all collection types and skips expired keys", async () => {
        await kv.set("t:string", "v");
        await kv.hset("t:hash", "f", "v");
        await kv.sadd("t:set", "m");
        await kv.rpush("t:list", "v");
        await kv.zadd("t:zset", 1, "m");
        await kv.set("t:expired", "v", { px: 20 });
        await sleep(50);
        expect(await kv.exists("t:expired")).toBe(0);
        expect((await kv.keys("t:*")).sort()).toEqual([
          "t:hash",
          "t:list",
          "t:set",
          "t:string",
          "t:zset",
        ]);
      });

      it("scan pages through all keys", async () => {
        const expected: string[] = [];
        for (let i = 0; i < 25; i++) {
          const key = `scan:${String(i).padStart(2, "0")}`;
          expected.push(key);
          await kv.set(key, String(i));
        }
        const collected: string[] = [];
        let cursor = "0";
        do {
          const result = await kv.scan(cursor, { match: "scan:*", count: 7 });
          collected.push(...result.keys);
          cursor = result.cursor;
        } while (cursor !== "0");
        expect(collected.sort()).toEqual(expected);
      });
    });

    describe("expiry across collection types", () => {
      it("expire works on every type and removes whole collections", async () => {
        await kv.set("e:string", "v");
        await kv.hset("e:hash", "f", "v");
        await kv.sadd("e:set", "m");
        await kv.rpush("e:list", "v");
        await kv.zadd("e:zset", 1, "m");

        for (const key of ["e:string", "e:hash", "e:set", "e:list", "e:zset"]) {
          expect(await kv.expire(key, 1)).toBe(true);
          expect(await kv.ttl(key)).toBeGreaterThan(0);
        }
        expect(await kv.expire("e:missing", 1)).toBe(false);

        await sleep(1100);

        expect(
          await kv.exists("e:string", "e:hash", "e:set", "e:list", "e:zset")
        ).toBe(0);
        expect(await kv.get("e:string")).toBeNull();
        expect(await kv.hgetall("e:hash")).toEqual({});
        expect(await kv.smembers("e:set")).toEqual([]);
        expect(await kv.lrange("e:list", 0, -1)).toEqual([]);
        expect(await kv.zrange("e:zset", 0, -1)).toEqual([]);
      });
    });

    describe("transactions", () => {
      it("exec runs queued commands in order and returns their results", async () => {
        const results = await kv
          .multi()
          .set("t:s", "1")
          .incr("t:s")
          .sadd("t:set", "a", "b")
          .rpush("t:list", "x", "y")
          .zadd("t:z", 1, "m")
          .hset("t:h", "f", "v")
          .expire("t:s", 100)
          .del("t:gone")
          .exec();
        expect(results).toEqual(["OK", 2, 2, 2, 1, 1, true, 0]);

        expect(await kv.get("t:s")).toBe("2");
        expect(await kv.ttl("t:s")).toBeGreaterThan(0);
        expect((await kv.smembers("t:set")).sort()).toEqual(["a", "b"]);
        expect(await kv.lrange("t:list", 0, -1)).toEqual(["x", "y"]);
        expect(await kv.zscore("t:z", "m")).toBe(1);
        expect(await kv.hget("t:h", "f")).toBe("v");
      });

      it("exec supports removal commands and get", async () => {
        await kv.hmset("t:h", { f: "v", g: "w" });
        await kv.sadd("t:set", "a", "b");
        await kv.zadd("t:z", 1, "m");
        await kv.set("t:s", "value");
        const results = await kv
          .multi()
          .get("t:s")
          .hdel("t:h", "f")
          .srem("t:set", "a")
          .zrem("t:z", "m")
          .lpush("t:list", "head")
          .exec();
        expect(results).toEqual(["value", 1, 1, 1, 1]);
        expect(await kv.hgetall("t:h")).toEqual({ g: "w" });
        expect(await kv.smembers("t:set")).toEqual(["b"]);
        expect(await kv.zcard("t:z")).toBe(0);
        expect(await kv.lrange("t:list", 0, -1)).toEqual(["head"]);
      });

      it("discard clears queued commands", async () => {
        const tx = kv.multi().set("t:d", "1");
        tx.discard();
        expect(await tx.exec()).toEqual([]);
        expect(await kv.get("t:d")).toBeNull();
      });
    });

    describe("pub/sub", () => {
      it("delivers published messages to subscribers", async () => {
        const received: Array<{ message: string; channel: string }> = [];
        await kv.subscribe("chan", (message, channel) => {
          received.push({ message, channel });
        });
        expect(await kv.publish("chan", "hello")).toBe(1);
        expect(received).toEqual([{ message: "hello", channel: "chan" }]);
      });

      it("delivers to two subscribers on one channel", async () => {
        const first: string[] = [];
        const second: string[] = [];
        await kv.subscribe("chan", (message) => first.push(message));
        await kv.subscribe("chan", (message) => second.push(message));
        await kv.publish("chan", "hello");
        expect(first).toEqual(["hello"]);
        expect(second).toEqual(["hello"]);
      });

      it("psubscribe matches glob patterns", async () => {
        const received: Array<{ message: string; channel: string }> = [];
        await kv.psubscribe("news.*", (message, channel) => {
          received.push({ message, channel });
        });
        await kv.publish("news.sports", "goal");
        await kv.publish("weather.today", "rain");
        expect(received).toEqual([{ message: "goal", channel: "news.sports" }]);
      });

      it("delivers one publish to exact and pattern subscribers", async () => {
        const exact: string[] = [];
        const pattern: string[] = [];
        await kv.subscribe("news.sports", (message) => exact.push(message));
        await kv.psubscribe("news.*", (message) => pattern.push(message));
        await kv.publish("news.sports", "goal");
        expect(exact).toEqual(["goal"]);
        expect(pattern).toEqual(["goal"]);
      });

      it("unsubscribe stops delivery", async () => {
        const received: string[] = [];
        await kv.subscribe("chan", (message) => received.push(message));
        await kv.publish("chan", "first");
        await kv.unsubscribe("chan");
        expect(await kv.publish("chan", "second")).toBe(0);
        expect(received).toEqual(["first"]);
      });

      it("punsubscribe stops delivery", async () => {
        const received: string[] = [];
        await kv.psubscribe("news.*", (message) => received.push(message));
        await kv.publish("news.sports", "first");
        await kv.punsubscribe("news.*");
        expect(await kv.publish("news.sports", "second")).toBe(0);
        expect(received).toEqual(["first"]);
      });

      it("publish without subscribers returns 0", async () => {
        expect(await kv.publish("nobody", "hello")).toBe(0);
      });
    });

    describe("eval", () => {
      it("returns null", async () => {
        expect(await kv.eval("return 1", [], [])).toBeNull();
      });
    });
  });
};

runKVAdapterConformance("memory", () => createMemoryKV());
runKVAdapterConformance("durable-object", () =>
  createDurableObjectKV(new FakeNamespace(), { reconnectDelay: () => 0 })
);

describe("Durable Object KV specifics", () => {
  let namespace: FakeNamespace;
  let kv: KVAdapter;

  beforeEach(async () => {
    namespace = new FakeNamespace();
    kv = createDurableObjectKV(namespace, { reconnectDelay: () => 0 });
    await kv.connect();
    return async () => {
      await kv.disconnect();
    };
  });

  it("handles logical keys containing colons and spaces", async () => {
    await kv.set("user name:1", "value");
    await kv.hset("user name:1 h", "field a", "x");
    expect(await kv.get("user name:1")).toBe("value");
    expect(await kv.hget("user name:1 h", "field a")).toBe("x");
    expect((await kv.keys("*")).sort()).toEqual(["user name:1", "user name:1 h"]);
  });

  it("does not collide hash fields across keys with overlapping names", async () => {
    await kv.hset("a", "b c", "1");
    await kv.hset("a b", "c", "2");
    expect(await kv.hgetall("a")).toEqual({ "b c": "1" });
    expect(await kv.hgetall("a b")).toEqual({ c: "2" });
  });

  it("does not collide collections under similar key names", async () => {
    await kv.sadd("col", "m");
    await kv.sadd("col2", "x");
    expect(await kv.smembers("col")).toEqual(["m"]);

    await kv.rpush("list", "a");
    await kv.rpush("list2", "b");
    expect(await kv.lrange("list", 0, -1)).toEqual(["a"]);

    await kv.hset("h", "f", "1");
    await kv.hset("h2", "f", "2");
    expect(await kv.hgetall("h")).toEqual({ f: "1" });

    await kv.zadd("z", 1, "m");
    await kv.zadd("z2", 2, "n");
    expect(await kv.zrange("z", 0, -1)).toEqual(["m"]);
  });

  it("round-trips a 500-field hash", async () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      data[`field-${i}`] = `value-${i}`;
    }
    await kv.hmset("big", data);
    expect(await kv.hgetall("big")).toEqual(data);
    expect(await kv.hlen("big")).toBe(500);
    expect(await kv.hget("big", "field-250")).toBe("value-250");
  });

  it("multi with a failing middle command matches memory semantics", async () => {
    const runFailingTransaction = async (
      adapter: KVAdapter,
      commandKey: "op" | "cmd"
    ) => {
      const tx = adapter.multi().set("fail:a", "1");
      (
        tx as unknown as { commands: Array<Record<string, unknown>> }
      ).commands.push({ [commandKey]: "bogus", args: [] });
      tx.set("fail:b", "2");
      await expect(tx.exec()).rejects.toThrow();
      return {
        first: await adapter.get("fail:a"),
        third: await adapter.get("fail:b"),
      };
    };

    const memory = createMemoryKV();
    await memory.connect();
    const memoryOutcome = await runFailingTransaction(memory, "cmd");
    await memory.disconnect();

    const durableOutcome = await runFailingTransaction(kv, "op");

    expect(memoryOutcome).toEqual({ first: "1", third: null });
    expect(durableOutcome).toEqual(memoryOutcome);
  });

  it("reconnects after an unexpected socket close and keeps receiving", async () => {
    const received: string[] = [];
    await kv.subscribe("chan", (message) => received.push(message));
    await kv.publish("chan", "before");
    expect(received).toEqual(["before"]);

    const state = namespace.states.get("covara-kv")!;
    const [serverSocket] = state.getWebSockets("chan");
    (serverSocket as FakeWebSocket).close();

    await vi.waitFor(() => {
      expect(state.getWebSockets("chan").length).toBe(1);
    });

    await kv.publish("chan", "after");
    expect(received).toEqual(["before", "after"]);
  });

  it("delivers publishes across adapter instances", async () => {
    const other = createDurableObjectKV(namespace, { reconnectDelay: () => 0 });
    await other.connect();

    const received: string[] = [];
    await kv.subscribe("chan", (message) => received.push(message));
    expect(await other.publish("chan", "cross")).toBe(1);
    expect(received).toEqual(["cross"]);

    const otherReceived: string[] = [];
    await other.subscribe("chan", (message) => otherReceived.push(message));
    expect(await kv.publish("chan", "both")).toBe(2);
    expect(received).toEqual(["cross", "both"]);
    expect(otherReceived).toEqual(["both"]);

    await other.disconnect();
  });

  it("subscribes to channels containing commas and percent signs", async () => {
    const received: Array<{ message: string; channel: string }> = [];
    await kv.subscribe("we,ird%chan", (message, channel) => {
      received.push({ message, channel });
    });
    expect(await kv.publish("we,ird%chan", "hello")).toBe(1);
    expect(received).toEqual([{ message: "hello", channel: "we,ird%chan" }]);
  });

  it("keeps receiving on remaining channels after a partial unsubscribe", async () => {
    const a: string[] = [];
    const b: string[] = [];
    await kv.subscribe("chan-a", (message) => a.push(message));
    await kv.subscribe("chan-b", (message) => b.push(message));
    await kv.unsubscribe("chan-a");
    expect(await kv.publish("chan-a", "lost")).toBe(0);
    expect(await kv.publish("chan-b", "kept")).toBe(1);
    expect(a).toEqual([]);
    expect(b).toEqual(["kept"]);
  });

  it("isolates adapters with different prefixes on the same namespace", async () => {
    const first = createDurableObjectKV(namespace, { prefix: "p1" });
    const second = createDurableObjectKV(namespace, { prefix: "p2" });
    await first.connect();
    await second.connect();

    await first.set("shared", "one");
    await second.set("shared", "two");
    expect(await first.get("shared")).toBe("one");
    expect(await second.get("shared")).toBe("two");
    expect(await first.keys("*")).toEqual(["shared"]);
    expect(await second.keys("*")).toEqual(["shared"]);

    await first.disconnect();
    await second.disconnect();
  });

  it("tracks connection state through connect and disconnect", async () => {
    const adapter = createDurableObjectKV(namespace);
    expect(adapter.isConnected()).toBe(false);
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});

describe("createKV durable-object wiring", () => {
  it("creates a working adapter from config", async () => {
    const namespace = new FakeNamespace();
    const kv = await createKV({
      type: "durable-object",
      prefix: "app",
      durableObject: { namespace },
    });
    expect(kv.isConnected()).toBe(true);
    await kv.set("k", "v");
    expect(await kv.get("k")).toBe("v");
    await kv.disconnect();
  });

  it("throws when the namespace is missing", async () => {
    await expect(
      createKV({ type: "durable-object" })
    ).rejects.toThrow(/namespace required/i);
  });
});

describe("memory transaction failure parity helper", () => {
  it("memory store exposes _execCommand for transactions", async () => {
    const memory = new MemoryKVStore();
    await memory.connect();
    await expect(memory._execCommand("bogus", [])).rejects.toThrow(
      /Unknown command/
    );
    await memory.disconnect();
  });
});

describe("Workers cross-request I/O safety (per-op stub derivation)", () => {
  // Simulates the Cloudflare constraint: a DO stub is bound to the request in
  // which it was created; using its .fetch() in a later request throws
  // OutgoingFactory. A single backing DO is shared, only the stub is scoped.
  let currentRequest = 0;

  class RequestScopedNamespace implements DurableObjectNamespaceLike {
    private state = new FakeDOState();
    private object = new CovaraKVDurableObject(this.state);
    getCalls = 0;

    idFromName(name: string): unknown {
      return name;
    }

    get(_id: unknown): DurableObjectStubLike {
      this.getCalls++;
      const boundTo = currentRequest;
      const target = this.object;
      return {
        fetch: (input, init) => {
          if (boundTo !== currentRequest) {
            throw new Error(
              "Cannot perform I/O on behalf of a different request (I/O type: OutgoingFactory)"
            );
          }
          return target.fetch(new Request(input, init as RequestInit));
        },
      };
    }
  }

  it("survives KV ops across simulated requests and derives a fresh stub per op", async () => {
    const ns = new RequestScopedNamespace();

    // Request 1: build the store (as buildApp(env) would) and do a write.
    currentRequest = 1;
    const kv = createDurableObjectKV(ns);
    await kv.connect();
    await kv.set("k", "v1");
    const callsAfterReq1 = ns.getCalls;

    // Request 2: the store is memoized/reused; a read must NOT throw
    // OutgoingFactory (the previous code cached the request-1 stub and 500ed).
    currentRequest = 2;
    await expect(kv.get("k")).resolves.toBe("v1");

    // Request 3: another write, still fine.
    currentRequest = 3;
    await kv.incr("counter");
    await expect(kv.get("counter")).resolves.toBe("1");

    // A fresh stub was derived for each operation, not cached once.
    expect(ns.getCalls).toBeGreaterThan(callsAfterReq1);

    await kv.disconnect();
  });
});

describe("scoped subscriptions are isolated (Workers bulletproof)", () => {
  it("closing one scoped subscription never affects another's delivery", async () => {
    const ns = new FakeNamespace();
    const kv = createDurableObjectKV(ns);
    await kv.connect();

    const a: string[] = [];
    const b: string[] = [];
    const subA = await kv.subscribeScoped!(["covara:events"], (msg) => a.push(msg));
    const subB = await kv.subscribeScoped!(["covara:events"], (msg) => b.push(msg));

    await kv.publish("covara:events", "m1");
    await sleep(0);
    expect(a).toEqual(["m1"]);
    expect(b).toEqual(["m1"]);

    // Close only A (as one SSE stream ending would). B's dedicated socket is
    // untouched and keeps receiving — the previous shared-socket design broke B.
    await subA.close();
    await kv.publish("covara:events", "m2");
    await sleep(0);
    expect(a).toEqual(["m1"]);
    expect(b).toEqual(["m1", "m2"]);

    await subB.close();
    await kv.publish("covara:events", "m3");
    await sleep(0);
    expect(b).toEqual(["m1", "m2"]);

    await kv.disconnect();
  });

  it("a scoped subscription is independent of the shared subscribe() socket", async () => {
    const ns = new FakeNamespace();
    const kv = createDurableObjectKV(ns);
    await kv.connect();

    const shared: string[] = [];
    const scoped: string[] = [];
    await kv.subscribe("covara:events", (msg) => shared.push(msg));
    const sub = await kv.subscribeScoped!(["covara:events"], (msg) => scoped.push(msg));

    await kv.publish("covara:events", "x");
    await sleep(0);
    expect(shared).toEqual(["x"]);
    expect(scoped).toEqual(["x"]);

    // Closing the scoped socket leaves the shared subscription working.
    await sub.close();
    await kv.publish("covara:events", "y");
    await sleep(0);
    expect(shared).toEqual(["x", "y"]);
    expect(scoped).toEqual(["x"]);

    await kv.disconnect();
  });
});
