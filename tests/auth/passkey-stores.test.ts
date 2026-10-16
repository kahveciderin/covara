import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  InMemoryPasskeyStore,
  KVPasskeyStore,
  InMemoryPasskeyChallengeStore,
  createKVPasskeyChallengeStore,
  type PasskeyStore,
  type StoredPasskey,
} from "@/auth/passkey";
import { DrizzlePasskeyStore } from "@/auth/stores/drizzle-passkeys";
import { migrateInternal } from "@/db/migrate";
import { defineInternalSchema, INTERNAL_TABLE_NAMES } from "@/db/internal-schema";
import { createMemoryKV } from "@/kv";

const passkey = (overrides: Partial<StoredPasskey> = {}): StoredPasskey => ({
  id: "cred-1",
  userId: "u-1",
  webauthnUserId: "handle-1",
  publicKey: "pk",
  counter: 0,
  transports: ["internal", "hybrid"],
  deviceType: "multiDevice",
  backedUp: true,
  name: "Laptop",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: null,
  ...overrides,
});

const sqliteStore = async () => {
  const db = drizzleLibsql(createClient({ url: ":memory:" }));
  await migrateInternal(db);
  return new DrizzlePasskeyStore({ db });
};

const pgStore = async () => {
  const db = drizzlePglite(new PGlite());
  await migrateInternal(db);
  return new DrizzlePasskeyStore({ db });
};

const kvStore = async () => {
  const kv = createMemoryKV();
  await kv.connect();
  return new KVPasskeyStore(kv);
};

const customTableStore = async () => {
  const myPasskeys = sqliteTable("my_passkeys", {
    credentialId: text("credential_id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    handle: text("handle").notNull(),
    key: text("key").notNull(),
    signCount: integer("sign_count").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  });
  const schema = defineInternalSchema({
    passkeys: {
      table: myPasskeys,
      fieldMap: {
        id: myPasskeys.credentialId,
        userId: "ownerId",
        webauthnUserId: "handle",
        publicKey: "key",
        counter: myPasskeys.signCount,
      },
    },
  });
  const db = drizzleLibsql(createClient({ url: ":memory:" }));
  await migrateInternal(db, { schema });
  return new DrizzlePasskeyStore({ db, resolver: schema.passkeys });
};

const stores: Array<[string, () => Promise<PasskeyStore>]> = [
  ["memory", async () => new InMemoryPasskeyStore()],
  ["kv", kvStore],
  ["drizzle sqlite", sqliteStore],
  ["drizzle postgres", pgStore],
];

describe.each(stores)("PasskeyStore contract: %s", (_name, make) => {
  it("creates, finds and lists by user", async () => {
    const store = await make();
    await store.create(passkey());
    await store.create(passkey({ id: "cred-2", createdAt: new Date("2026-02-01T00:00:00Z") }));
    await store.create(passkey({ id: "cred-3", userId: "u-2" }));

    const found = await store.findById("cred-1");
    expect(found).toEqual(passkey());
    expect((await store.listByUser("u-1")).map((p) => p.id)).toEqual(["cred-1", "cred-2"]);
    expect(await store.listByUser("nobody")).toEqual([]);
    expect(await store.findById("missing")).toBeNull();
  });

  it("refuses a duplicate credential id", async () => {
    const store = await make();
    await store.create(passkey());
    await expect(store.create(passkey({ userId: "u-2" }))).rejects.toThrow();
    expect((await store.findById("cred-1"))?.userId).toBe("u-1");
  });

  it("updates counter, lastUsedAt, backedUp and name", async () => {
    const store = await make();
    await store.create(passkey());
    const usedAt = new Date("2026-03-01T00:00:00Z");
    await store.update("cred-1", { counter: 4_000_000_000, lastUsedAt: usedAt, backedUp: false, name: null });
    const updated = await store.findById("cred-1");
    expect(updated).toMatchObject({ counter: 4_000_000_000, backedUp: false, name: null });
    expect(updated?.lastUsedAt?.getTime()).toBe(usedAt.getTime());
    await store.update("missing", { counter: 1 });
    expect(await store.findById("missing")).toBeNull();
  });

  it("deletes and drops the credential from the user's list", async () => {
    const store = await make();
    await store.create(passkey());
    await store.delete("cred-1");
    expect(await store.findById("cred-1")).toBeNull();
    expect(await store.listByUser("u-1")).toEqual([]);
    await store.delete("cred-1");
  });

  it("does not leak mutations of returned objects back into the store", async () => {
    const store = await make();
    await store.create(passkey());
    const found = await store.findById("cred-1");
    found!.counter = 99;
    found!.transports!.push("usb");
    expect((await store.findById("cred-1"))?.counter).toBe(0);
    expect((await store.findById("cred-1"))?.transports).toEqual(["internal", "hybrid"]);
  });
});

describe("DrizzlePasskeyStore with a remapped custom table", () => {
  it("works with only the required columns mapped", async () => {
    const store = await customTableStore();
    await store.create(passkey());
    const found = await store.findById("cred-1");
    expect(found).toMatchObject({
      id: "cred-1",
      userId: "u-1",
      webauthnUserId: "handle-1",
      publicKey: "pk",
      counter: 0,
      transports: null,
      name: null,
    });
    await store.update("cred-1", { counter: 3, name: "ignored", lastUsedAt: new Date() });
    expect((await store.findById("cred-1"))?.counter).toBe(3);
    expect(await store.listByUser("u-1")).toHaveLength(1);
  });

  it("rejects a custom table missing a required column", () => {
    const bad = sqliteTable("bad_passkeys", { id: text("id").primaryKey() });
    expect(() => defineInternalSchema({ passkeys: { table: bad } })).toThrow(/passkeys\.userId/);
  });
});

describe("internal schema includes auth_passkeys", () => {
  it("is listed and migrated", async () => {
    expect(INTERNAL_TABLE_NAMES).toContain("auth_passkeys");
    const db = drizzleLibsql(createClient({ url: ":memory:" }));
    const summary = await migrateInternal(db);
    expect(summary.tables).toContain("auth_passkeys");
    await migrateInternal(db);
  });
});

describe("passkey challenge stores", () => {
  it.each([
    ["memory", async () => new InMemoryPasskeyChallengeStore()],
    [
      "kv",
      async () => {
        const kv = createMemoryKV();
        await kv.connect();
        return createKVPasskeyChallengeStore(kv);
      },
    ],
  ] as const)("%s: single-use under concurrent consumption", async (_name, make) => {
    const store = await make();
    const data = { purpose: "authentication" as const, expiresAt: Date.now() + 60_000 };
    await store.set("ch", data, 60_000);
    const results = await Promise.all([store.consume("ch"), store.consume("ch"), store.consume("ch")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await store.consume("ch")).toBeNull();
  });

  it("treats an entry past its expiresAt as missing", async () => {
    const store = new InMemoryPasskeyChallengeStore();
    store.set("old", { purpose: "registration", expiresAt: Date.now() - 1 });
    expect(store.consume("old")).toBeNull();
  });
});
