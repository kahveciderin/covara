import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryKV } from "@/kv/memory";
import {
  KVSessionStore,
  createKVSessionStore,
  createRedisSessionStore,
  RedisSessionStore,
} from "@/auth/stores";
import { SessionData } from "@/auth/types";

const makeSession = (id: string, userId: string): SessionData => ({
  id,
  userId,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-02T00:00:00Z"),
  data: { foo: "bar" },
});

describe("KVSessionStore (works over any KV adapter)", () => {
  let store: KVSessionStore;

  beforeEach(async () => {
    const kv = createMemoryKV();
    await kv.connect();
    store = createKVSessionStore({ kv, prefix: "sess" });
  });

  it("round-trips a session over the in-memory KV backend", async () => {
    await store.set("s1", makeSession("s1", "u1"), 60_000);
    const got = await store.get("s1");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("s1");
    expect(got?.userId).toBe("u1");
    expect(got?.data).toEqual({ foo: "bar" });
    expect(got?.createdAt).toBeInstanceOf(Date);
  });

  it("indexes by user and deletes by user", async () => {
    await store.set("s1", makeSession("s1", "u1"), 60_000);
    await store.set("s2", makeSession("s2", "u1"), 60_000);
    await store.set("s3", makeSession("s3", "u2"), 60_000);

    const u1 = await store.getByUser("u1");
    expect(u1.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(await store.count()).toBe(3);

    const deleted = await store.deleteByUser("u1");
    expect(deleted).toBe(2);
    expect(await store.getByUser("u1")).toEqual([]);
    expect(await store.get("s3")).not.toBeNull();
    expect(await store.count()).toBe(1);
  });

  it("delete removes a single session and drops it from the user index", async () => {
    await store.set("s1", makeSession("s1", "u1"), 60_000);
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
    expect(await store.getByUser("u1")).toEqual([]);
  });

  it("exposes the deprecated Redis aliases pointing at the same store", () => {
    expect(RedisSessionStore).toBe(KVSessionStore);
    expect(createRedisSessionStore).toBe(createKVSessionStore);
  });
});
