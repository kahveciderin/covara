import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { migrateInternal, autoMigrate, detectDialect } from "@/db/migrate";
import { seed, createSeed } from "@/db/seed";
import { recommendedPoolConfig, type PoolDriver } from "@/db/pooling";
import {
  authSessionsSqlite,
  authAccountsSqlite,
  authApiKeysSqlite,
  authVerificationTokensSqlite,
  INTERNAL_TABLE_NAMES,
} from "@/db/internal-schema";

const makeSqlite = () => {
  const client = createClient({ url: ":memory:" });
  return drizzleLibsql(client);
};

describe("migrateInternal (SQLite/libsql)", () => {
  let db: ReturnType<typeof makeSqlite>;

  beforeEach(() => {
    db = makeSqlite();
  });

  it("auto-detects the sqlite dialect", () => {
    expect(detectDialect(db)).toBe("sqlite");
  });

  it("creates all internal tables and reports a summary", async () => {
    const summary = await migrateInternal(db);
    expect(summary.dialect).toBe("sqlite");
    expect(summary.tables.sort()).toEqual([...INTERNAL_TABLE_NAMES].sort());
    expect(summary.statements).toBeGreaterThan(0);
  });

  it("each table is usable: insert + select a row", async () => {
    await migrateInternal(db);
    const now = new Date();

    await db.insert(authSessionsSqlite).values({
      id: "s1",
      userId: "u1",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
      data: null,
    });
    await db.insert(authAccountsSqlite).values({
      userId: "u1",
      type: "oauth",
      provider: "google",
      providerAccountId: "g1",
    });
    await db.insert(authApiKeysSqlite).values({
      id: "k1",
      userId: "u1",
      name: "ci",
      keyHash: "hash",
      keyPrefix: "pfx",
      scopes: ["read"],
      createdAt: now,
    });
    await db.insert(authVerificationTokensSqlite).values({
      identifier: "a@b.c",
      token: "t1",
      expires: new Date(now.getTime() + 1000),
    });

    const sessions = await db.select().from(authSessionsSqlite);
    const accounts = await db.select().from(authAccountsSqlite);
    const keys = await db.select().from(authApiKeysSqlite);
    const tokens = await db.select().from(authVerificationTokensSqlite);

    expect(sessions).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(keys[0].scopes).toEqual(["read"]);
    expect(tokens[0].identifier).toBe("a@b.c");
  });

  it("is idempotent: running twice does not throw", async () => {
    await migrateInternal(db);
    await expect(migrateInternal(db)).resolves.toMatchObject({
      dialect: "sqlite",
    });
  });

  it("autoMigrate is an alias that succeeds", async () => {
    await expect(autoMigrate(db)).resolves.toMatchObject({ dialect: "sqlite" });
  });
});

describe("migrateInternal (PostgreSQL/PGlite)", () => {
  it("creates internal tables and is idempotent on Postgres", async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);

    expect(detectDialect(db)).toBe("postgresql");

    const summary = await migrateInternal(db);
    expect(summary.dialect).toBe("postgresql");

    await migrateInternal(db);

    const now = new Date();
    await db.insert(authSessionsSqlite as never).values({
      id: "s1",
      userId: "u1",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
    } as never);

    const rows = (await db.execute(
      sql`SELECT count(*)::int as cnt FROM auth_sessions`
    )) as { rows: { cnt: number }[] };
    expect(rows.rows[0].cnt).toBe(1);
  });
});

describe("seed", () => {
  let db: ReturnType<typeof makeSqlite>;

  beforeEach(async () => {
    db = makeSqlite();
    await migrateInternal(db);
  });

  it("inserts rows and is idempotent on re-run", async () => {
    const now = new Date();
    const rows = [
      {
        id: "k1",
        userId: "u1",
        name: "first",
        keyHash: "h1",
        keyPrefix: "p1",
        createdAt: now,
      },
      {
        id: "k2",
        userId: "u1",
        name: "second",
        keyHash: "h2",
        keyPrefix: "p2",
        createdAt: now,
      },
    ];

    const summary = await seed(db, {
      tables: [{ table: authApiKeysSqlite, rows }],
    });
    expect(summary.rows).toBe(2);

    await seed(db, { tables: [{ table: authApiKeysSqlite, rows }] });

    const all = await db.select().from(authApiKeysSqlite);
    expect(all).toHaveLength(2);
  });

  it("supports the builder form", async () => {
    const now = new Date();
    await createSeed()
      .table(authApiKeysSqlite, [
        {
          id: "b1",
          userId: "u1",
          name: "builder",
          keyHash: "h",
          keyPrefix: "p",
          createdAt: now,
        },
      ])
      .run(db);

    const all = await db.select().from(authApiKeysSqlite);
    expect(all).toHaveLength(1);
  });
});

describe("recommendedPoolConfig", () => {
  const drivers: PoolDriver[] = [
    "postgres-js",
    "neon",
    "pglite",
    "libsql",
    "d1",
    "hyperdrive",
  ];

  it("returns a sane shape for every driver", () => {
    for (const driver of drivers) {
      const config = recommendedPoolConfig(driver);
      expect(typeof config.max).toBe("number");
      expect(config.max).toBeGreaterThanOrEqual(1);
      expect(typeof config.idleTimeoutMs).toBe("number");
      expect(typeof config.connectTimeoutMs).toBe("number");
      expect(typeof config.notes).toBe("string");
      expect(config.notes.length).toBeGreaterThan(0);
    }
  });

  it("postgres-js recommends a multi-connection pool", () => {
    expect(recommendedPoolConfig("postgres-js").max).toBeGreaterThan(1);
  });

  it("returns a fresh object (not a shared reference)", () => {
    const a = recommendedPoolConfig("neon");
    a.max = 999;
    expect(recommendedPoolConfig("neon").max).not.toBe(999);
  });
});
