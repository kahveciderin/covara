import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryKV } from "@/kv/memory";
import { KVAdapter } from "@/kv";
import {
  createApiKey,
  verifyApiKey,
  listApiKeys,
  revokeApiKey,
  createKVApiKeyStore,
} from "@/auth/api-keys";
import {
  issueToken,
  verifyToken,
  createKVVerificationTokenStore,
} from "@/auth/verification";

describe("KVApiKeyStore", () => {
  let kv: KVAdapter;
  beforeEach(async () => {
    kv = createMemoryKV();
    await kv.connect();
  });

  it("creates, verifies, lists, and revokes keys over KV", async () => {
    const store = createKVApiKeyStore(kv);
    const { key } = await createApiKey({ store, userId: "u1", label: "ci" });
    const otherUser = await createApiKey({ store, userId: "u2" });

    const result = await verifyApiKey(key, { store });
    expect(result.valid).toBe(true);
    expect(result.metadata?.userId).toBe("u1");

    const u1Keys = await listApiKeys({ store, userId: "u1" });
    expect(u1Keys).toHaveLength(1);
    const all = await listApiKeys({ store });
    expect(all).toHaveLength(2);

    await revokeApiKey(result.metadata!.id, { store });
    expect((await verifyApiKey(key, { store })).valid).toBe(false);
    expect(await listApiKeys({ store })).toHaveLength(1);
    expect(otherUser.metadata.userId).toBe("u2");
  });

  it("touch updates lastUsedAt and a key survives a fresh store instance", async () => {
    const store1 = createKVApiKeyStore(kv);
    const { key } = await createApiKey({ store: store1, userId: "u1" });
    await verifyApiKey(key, { store: store1 }); // touches lastUsedAt

    const store2 = createKVApiKeyStore(kv); // new "instance", same KV
    const res = await verifyApiKey(key, { store: store2 });
    expect(res.valid).toBe(true);
    expect(res.metadata?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("KVVerificationTokenStore", () => {
  let kv: KVAdapter;
  beforeEach(async () => {
    kv = createMemoryKV();
    await kv.connect();
  });

  it("issues and verifies a token (single-use) over KV", async () => {
    const store = createKVVerificationTokenStore(kv);
    const { token } = await issueToken(store, "alice@test.com", 60_000);

    // A second "instance" verifies against shared KV.
    const store2 = createKVVerificationTokenStore(kv);
    expect(await verifyToken(store2, "alice@test.com", token)).toBe(true);
    // single-use: consumed
    expect(await verifyToken(store2, "alice@test.com", token)).toBe(false);
  });

  it("issuing a new token deletes prior tokens for the identifier", async () => {
    const store = createKVVerificationTokenStore(kv);
    const first = await issueToken(store, "bob@test.com", 60_000);
    await issueToken(store, "bob@test.com", 60_000);
    expect(await verifyToken(store, "bob@test.com", first.token)).toBe(false);
  });
});
