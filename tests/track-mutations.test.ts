import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";
import {
  trackMutations,
  isTrackedDb,
  invalidateCache,
  invalidateAllCache,
} from "@/resource/track-mutations";
import { changelog } from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { clearAllSubscriptions } from "@/resource/subscription";
import { ChangelogEntry } from "@/resource/types";

const todosTable = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  userId: text("userId"),
});

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
});

describe("Mutation Tracking", () => {
  let kv: KVAdapter;
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    kv = createMemoryKV("track-mutations-test");
    await kv.connect();
    setGlobalKV(kv);

    client = createClient({ url: ":memory:" });
    db = drizzle(client);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        userId TEXT
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `);
  });

  afterAll(async () => {
    client.close();
    await kv.disconnect();
  });

  beforeEach(async () => {
    await changelog.clear();
    await clearAllSubscriptions();
    await db.run(sql`DROP TABLE IF EXISTS todos`);
    await db.run(sql`DROP TABLE IF EXISTS users`);
    await db.run(sql`
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        userId TEXT
      )
    `);
    await db.run(sql`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `);
  });

  describe("Insert Tracking (Builder Pattern)", () => {
    it("should track single insert with returning", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      const [todo] = await trackedDb
        .insert(todosTable)
        .values({ id: "1", title: "Test todo" })
        .returning();

      expect(todo.id).toBe("1");
      expect(todo.title).toBe("Test todo");
      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe("create");
      expect(mutations[0].resource).toBe("todos");
      expect(mutations[0].objectId).toBe("1");
      expect(mutations[0].object).toEqual({ id: "1", title: "Test todo", completed: false, userId: null });
    });

    it("should track batch insert with returning", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      const todos = await trackedDb
        .insert(todosTable)
        .values([
          { id: "1", title: "First" },
          { id: "2", title: "Second" },
          { id: "3", title: "Third" },
        ])
        .returning();

      expect(todos).toHaveLength(3);
      expect(mutations).toHaveLength(3);
      expect(mutations.map(m => m.objectId)).toEqual(["1", "2", "3"]);
    });

    it("should record to global changelog", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values({ id: "1", title: "Test" })
        .returning();

      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("create");
      expect(entries[0].objectId).toBe("1");
    });
  });

  describe("Update Tracking (Builder Pattern)", () => {
    it("should track update with previousObject", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values({ id: "1", title: "Original" })
        .returning();

      await changelog.clear();

      const [updated] = await trackedDb
        .update(todosTable)
        .set({ title: "Updated" })
        .where(eq(todosTable.id, "1"))
        .returning();

      expect(updated.title).toBe("Updated");

      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("update");
      expect(entries[0].objectId).toBe("1");
      expect(entries[0].object?.title).toBe("Updated");
      expect(entries[0].previousObject?.title).toBe("Original");
    });

    it("should track batch update", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values([
          { id: "1", title: "First", completed: false },
          { id: "2", title: "Second", completed: false },
        ])
        .returning();

      mutations.length = 0;

      await trackedDb
        .update(todosTable)
        .set({ completed: true })
        .where(eq(todosTable.completed, false))
        .returning();

      expect(mutations).toHaveLength(2);
      expect(mutations.every(m => m.type === "update")).toBe(true);
    });

    it("should track update without returning using the pre-mutation SELECT", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values([
          { id: "1", title: "First", completed: false },
          { id: "2", title: "Second", completed: false },
        ])
        .returning();

      mutations.length = 0;
      await changelog.clear();

      // No .returning() — affected rows must be derived from the pre-mutation SELECT,
      // not from the driver's result-summary object.
      await trackedDb
        .update(todosTable)
        .set({ completed: true })
        .where(eq(todosTable.completed, false));

      expect(mutations).toHaveLength(2);
      expect(mutations.every(m => m.type === "update")).toBe(true);
      expect(mutations.map(m => m.objectId).sort()).toEqual(["1", "2"]);
      for (const m of mutations) {
        expect(m.objectId).not.toBe("undefined");
        expect(m.object?.completed).toBe(true);
        expect(m.previousObject?.completed).toBe(false);
      }

      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries).toHaveLength(2);
      expect(entries.map(e => e.objectId).sort()).toEqual(["1", "2"]);
    });

    it("should record no changelog entry for an update without returning that affects no rows", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await changelog.clear();

      await trackedDb
        .update(todosTable)
        .set({ completed: true })
        .where(eq(todosTable.id, "does-not-exist"));

      expect(mutations).toHaveLength(0);
      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries).toHaveLength(0);
    });
  });

  describe("Delete Tracking (Builder Pattern)", () => {
    it("should track delete with previousObject", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values({ id: "1", title: "To delete" })
        .returning();

      mutations.length = 0;

      await trackedDb
        .delete(todosTable)
        .where(eq(todosTable.id, "1"));

      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe("delete");
      expect(mutations[0].objectId).toBe("1");
      expect(mutations[0].previousObject?.title).toBe("To delete");
    });

    it("should track batch delete", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb
        .insert(todosTable)
        .values([
          { id: "1", title: "First", completed: true },
          { id: "2", title: "Second", completed: true },
          { id: "3", title: "Third", completed: false },
        ])
        .returning();

      mutations.length = 0;

      await trackedDb
        .delete(todosTable)
        .where(eq(todosTable.completed, true));

      expect(mutations).toHaveLength(2);
      expect(mutations.every(m => m.type === "delete")).toBe(true);
      expect(mutations.map(m => m.objectId).sort()).toEqual(["1", "2"]);
    });
  });

  describe("Raw SQL Tracking", () => {
    it("should detect INSERT raw SQL and record with objectId *", async () => {
      const rawMutations: { resource: string; type: string }[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onRawSqlMutation: (resource, type) => {
          rawMutations.push({ resource, type });
        },
        pushToSubscriptions: false,
      });

      await trackedDb.run(sql`INSERT INTO todos (id, title) VALUES ('raw-1', 'Raw SQL insert')`);

      expect(rawMutations).toHaveLength(1);
      expect(rawMutations[0].resource).toBe("todos");
      expect(rawMutations[0].type).toBe("create");

      const entries = await changelog.getEntriesSince("todos", 0);
      const rawEntry = entries.find(e => e.objectId === "*");
      expect(rawEntry).toBeDefined();
      expect(rawEntry?.type).toBe("create");
    });

    it("should detect UPDATE raw SQL", async () => {
      const rawMutations: { resource: string; type: string }[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onRawSqlMutation: (resource, type) => {
          rawMutations.push({ resource, type });
        },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.run(sql`UPDATE todos SET title = 'Updated' WHERE id = '1'`);

      expect(rawMutations).toHaveLength(1);
      expect(rawMutations[0].resource).toBe("todos");
      expect(rawMutations[0].type).toBe("update");
    });

    it("should detect DELETE raw SQL", async () => {
      const rawMutations: { resource: string; type: string }[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onRawSqlMutation: (resource, type) => {
          rawMutations.push({ resource, type });
        },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.run(sql`DELETE FROM todos WHERE id = '1'`);

      expect(rawMutations).toHaveLength(1);
      expect(rawMutations[0].resource).toBe("todos");
      expect(rawMutations[0].type).toBe("delete");
    });

    it("should not record SELECT queries", async () => {
      const rawMutations: { resource: string; type: string }[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onRawSqlMutation: (resource, type) => {
          rawMutations.push({ resource, type });
        },
        pushToSubscriptions: false,
      });

      await trackedDb.run(sql`SELECT * FROM todos`);

      expect(rawMutations).toHaveLength(0);
    });
  });

  describe("Transaction Tracking", () => {
    it("should track mutations inside transactions", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.transaction(async (tx) => {
        await tx.insert(todosTable).values({ id: "tx-1", title: "In transaction" }).returning();
        await tx.update(todosTable).set({ title: "Updated in tx" }).where(eq(todosTable.id, "tx-1")).returning();
      });

      expect(mutations).toHaveLength(2);
      expect(mutations[0].type).toBe("create");
      expect(mutations[1].type).toBe("update");
    });

    it("should NOT emit changelog entries when a transaction rolls back", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await expect(
        trackedDb.transaction(async (tx) => {
          await tx.insert(todosTable).values({ id: "rollback-1", title: "Phantom" }).returning();
          throw new Error("force rollback");
        })
      ).rejects.toThrow("force rollback");

      expect(mutations).toHaveLength(0);
      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries.filter((e) => e.objectId === "rollback-1")).toHaveLength(0);
    });

    it("should emit changelog entries only after a transaction commits", async () => {
      const emittedBeforeCommit: boolean[] = [];
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.transaction(async (tx) => {
        await tx.insert(todosTable).values({ id: "commit-1", title: "Committed" }).returning();
        // Side effects must not have fired yet — the transaction is still open.
        emittedBeforeCommit.push(mutations.length > 0);
      });

      expect(emittedBeforeCommit).toEqual([false]);
      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe("create");
      expect(mutations[0].objectId).toBe("commit-1");
    });
  });

  describe("Batch Tracking (db.batch)", () => {
    it("should detect mutations inside db.batch() and record coarse invalidations", async () => {
      const rawMutations: { resource: string; type: string }[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onRawSqlMutation: (resource, type) => { rawMutations.push({ resource, type }); },
        pushToSubscriptions: false,
      });

      await trackedDb.batch([
        trackedDb.insert(todosTable).values({ id: "b1", title: "Batch 1" }),
        trackedDb.insert(todosTable).values({ id: "b2", title: "Batch 2" }),
      ]);

      // Two insert statements detected as create mutations.
      const creates = rawMutations.filter((m) => m.resource === "todos" && m.type === "create");
      expect(creates.length).toBe(2);

      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries.filter((e) => e.objectId === "*" && e.type === "create").length).toBe(2);

      // Rows were actually written.
      const rows = await db.select().from(todosTable);
      expect(rows.map((r) => r.id).sort()).toEqual(["b1", "b2"]);
    });
  });

  describe("Configuration Options", () => {
    it("should skip tables in skipTables list", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
        users: { table: usersTable, id: usersTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        skipTables: ["users"],
        pushToSubscriptions: false,
      });

      await trackedDb.insert(todosTable).values({ id: "1", title: "Todo" }).returning();
      await trackedDb.insert(usersTable).values({ id: "1", name: "User" }).returning();

      expect(mutations).toHaveLength(1);
      expect(mutations[0].resource).toBe("todos");
    });

    it("should support withoutTracking", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.withoutTracking(async (db) => {
        await db.insert(todosTable).values({ id: "no-track", title: "Not tracked" }).returning();
      });

      expect(mutations).toHaveLength(0);
    });

    it("should support custom resourceName", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        myTodos: { table: todosTable, id: todosTable.id, resourceName: "my-custom-todos" },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.insert(todosTable).values({ id: "1", title: "Todo" }).returning();

      expect(mutations).toHaveLength(1);
      expect(mutations[0].resource).toBe("my-custom-todos");
    });

    it("should not capture previousState when disabled", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        capturePreviousState: false,
        pushToSubscriptions: false,
      });

      await trackedDb.insert(todosTable).values({ id: "1", title: "Original" }).returning();
      mutations.length = 0;

      await trackedDb.update(todosTable).set({ title: "Updated" }).where(eq(todosTable.id, "1")).returning();

      expect(mutations).toHaveLength(1);
      expect(mutations[0].previousObject).toBeUndefined();
    });
  });

  describe("Untracked Tables", () => {
    it("should pass through operations on unregistered tables", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        pushToSubscriptions: false,
      });

      const [user] = await trackedDb.insert(usersTable).values({ id: "1", name: "User" }).returning();
      expect(user.id).toBe("1");

      const entries = await changelog.getEntriesSince("users", 0);
      expect(entries).toHaveLength(0);
    });
  });

  describe("Select Queries (No Tracking)", () => {
    it("should not track select queries", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });

      const todos = await trackedDb.select().from(todosTable);

      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe("Test");

      const entries = await changelog.getEntriesSince("todos", 0);
      expect(entries).toHaveLength(0);
    });
  });

  describe("isTrackedDb", () => {
    it("should return true for tracked db", () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        pushToSubscriptions: false,
      });

      expect(isTrackedDb(trackedDb)).toBe(true);
    });

    it("should return false for regular db", () => {
      expect(isTrackedDb(db)).toBe(false);
    });

    it("should return false for null/undefined", () => {
      expect(isTrackedDb(null)).toBe(false);
      expect(isTrackedDb(undefined)).toBe(false);
    });

    it("should return false for non-db objects", () => {
      expect(isTrackedDb({})).toBe(false);
      expect(isTrackedDb({ _trackingContext: {} })).toBe(false); // Missing _originalDb
      expect(isTrackedDb({ _originalDb: {} })).toBe(false); // Missing _trackingContext
    });
  });

  describe("Edge Cases", () => {
    it("should handle onConflictDoNothing with no mutation when conflict occurs", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.insert(todosTable).values({ id: "1", title: "First" }).returning();
      mutations.length = 0;

      await trackedDb.insert(todosTable).values({ id: "1", title: "Duplicate" }).onConflictDoNothing().returning();

      // With onConflictDoNothing, no mutation should be recorded when conflict occurs
      expect(mutations).toHaveLength(0);
    });

    it("should handle empty update", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.update(todosTable).set({ title: "Nonexistent" }).where(eq(todosTable.id, "nonexistent")).returning();

      expect(mutations).toHaveLength(0);
    });

    it("should handle empty delete", async () => {
      const mutations: ChangelogEntry[] = [];
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        onMutation: (entry) => { mutations.push(entry); },
        pushToSubscriptions: false,
      });

      await trackedDb.delete(todosTable).where(eq(todosTable.id, "nonexistent"));

      expect(mutations).toHaveLength(0);
    });
  });
});

describe("Query Caching", () => {
  let kv: KVAdapter;
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    kv = createMemoryKV("query-cache-test");
    await kv.connect();
    setGlobalKV(kv);

    client = createClient({ url: ":memory:" });
    db = drizzle(client);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        userId TEXT
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `);
  });

  afterAll(async () => {
    client.close();
    await kv.disconnect();
  });

  beforeEach(async () => {
    await changelog.clear();
    await clearAllSubscriptions();
    await invalidateAllCache();
    await db.run(sql`DELETE FROM todos`);
    await db.run(sql`DELETE FROM users`);
  });

  describe("Cache Behavior", () => {
    it("should cache select queries when enabled", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });

      const result1 = await trackedDb.select().from(todosTable);
      const result2 = await trackedDb.select().from(todosTable);

      expect(result1).toEqual(result2);
    });

    it("should invalidate cache on insert", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "First" });

      const result1 = await trackedDb.select().from(todosTable);
      expect(result1).toHaveLength(1);

      await trackedDb.insert(todosTable).values({ id: "2", title: "Second" }).returning();

      const result2 = await trackedDb.select().from(todosTable);
      expect(result2).toHaveLength(2);
    });

    it("should invalidate a cached JOIN query when a joined table mutates", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
        users: { table: usersTable, id: usersTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(usersTable).values({ id: "u1", name: "Original" });
      await db.insert(todosTable).values({ id: "1", title: "Task", userId: "u1" });

      const joinQuery = () =>
        trackedDb
          .select({ title: todosTable.title, userName: usersTable.name })
          .from(todosTable)
          .leftJoin(usersTable, eq(todosTable.userId, usersTable.id));

      const before = await joinQuery();
      expect(before[0].userName).toBe("Original");

      // Mutating the JOINED table (users) must invalidate the cached join,
      // even though the query's FROM table is todos.
      await trackedDb.update(usersTable).set({ name: "Renamed" }).where(eq(usersTable.id, "u1")).returning();

      const after = await joinQuery();
      expect(after[0].userName).toBe("Renamed");
    });

    it("should invalidate cache on update", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Original" });

      const result1 = await trackedDb.select().from(todosTable);
      expect(result1[0].title).toBe("Original");

      await trackedDb.update(todosTable).set({ title: "Updated" }).where(eq(todosTable.id, "1")).returning();

      const result2 = await trackedDb.select().from(todosTable);
      expect(result2[0].title).toBe("Updated");
    });

    it("should invalidate cache on delete", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values([
        { id: "1", title: "First" },
        { id: "2", title: "Second" },
      ]);

      const result1 = await trackedDb.select().from(todosTable);
      expect(result1).toHaveLength(2);

      await trackedDb.delete(todosTable).where(eq(todosTable.id, "1"));

      const result2 = await trackedDb.select().from(todosTable);
      expect(result2).toHaveLength(1);
    });

    it("should support TTL-based expiry", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true, ttl: 1000 },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });

      await trackedDb.select().from(todosTable);

      const keysSetBefore = await kv.smembers("covara:cache:keys:todos");
      expect(keysSetBefore.length).toBeGreaterThan(0);

      // Verify the cache key has data
      const cacheKey = keysSetBefore[0];
      const cachedBefore = await kv.get(cacheKey);
      expect(cachedBefore).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 1500));

      // After TTL, the cached data should be expired/null
      const cachedAfter = await kv.get(cacheKey);
      expect(cachedAfter).toBeNull();
    });
  });

  describe("Manual Cache Invalidation", () => {
    it("should support invalidateCache for specific resource", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.select().from(todosTable);

      await invalidateCache("todos");

      const keysSet = await kv.smembers("covara:cache:keys:todos");
      expect(keysSet).toHaveLength(0);
    });

    it("should support invalidateAllCache", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.select().from(todosTable);

      await invalidateAllCache();

      const cacheKeys = await kv.keys("covara:cache:*");
      expect(cacheKeys).toHaveLength(0);
    });
  });

  describe("Cache Configuration", () => {
    it("should support per-table cache settings", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: {
          enabled: true,
          tables: {
            todos: { enabled: false },
          },
        },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.select().from(todosTable);

      const keysSet = await kv.smembers("covara:cache:keys:todos");
      expect(keysSet).toHaveLength(0);
    });

    it("should support custom key prefix", async () => {
      const trackedDb = trackMutations(db, {
        todos: { table: todosTable, id: todosTable.id },
      }, {
        cache: { enabled: true, keyPrefix: "custom:cache:" },
        pushToSubscriptions: false,
      });

      await db.insert(todosTable).values({ id: "1", title: "Test" });
      await trackedDb.select().from(todosTable);

      const customKeys = await kv.keys("custom:cache:*");
      expect(customKeys.length).toBeGreaterThan(0);
    });
  });
});
