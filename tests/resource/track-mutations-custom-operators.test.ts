import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import type { SSEWriter } from "@/server/sse";
import type { CustomOperator } from "@/resource/types";
import { trackMutations } from "@/resource/track-mutations";
import {
  registerHandler,
  unregisterHandler,
  createSubscription,
  clearAllSubscriptions,
} from "@/resource/subscription";

const things = sqliteTable("cop_things", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tags: text("tags").notNull(), // JSON array string
});

const hasOperator: CustomOperator = {
  convert: (lhs, rhs) => sql`${lhs} LIKE '%"' || ${rhs} || '"%'`,
  execute: (lhs, rhs) => {
    try {
      return (JSON.parse(String(lhs)) as unknown[]).map(String).includes(String(rhs));
    } catch {
      return false;
    }
  },
};

// Captures the SSE frames a subscription handler would receive.
const captureWriter = () => {
  const events: any[] = [];
  const writer: SSEWriter = {
    write: (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            // non-JSON frame
          }
        }
      }
      return true;
    },
    close: () => {},
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    onClose: () => {},
  };
  return { writer, events };
};

// Bug: trackMutations built its fan-out matcher with NO custom operators. On a
// tracked write, the fan-out compiles each open subscription's filter against
// that matcher; a custom operator (e.g. `=has=`) in any subscription throws
// FilterParseError → the create/update 400s. This only surfaces on a cold filter
// cache (the compile actually runs) — i.e. cross-process, exactly the production
// case — so these tests clear the cache first to reproduce it deterministically.
describe("trackMutations fan-out honors the resource's custom operators", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    await clearAllSubscriptions(); // cold filter cache
    libsqlClient = createLibsqlClient({ url: ":memory:" });
    await libsqlClient.execute(
      `CREATE TABLE cop_things (id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL)`
    );
    db = drizzle(libsqlClient);
  });

  afterEach(async () => {
    await clearAllSubscriptions();
    libsqlClient.close();
  });

  const openSub = async (handlerId: string, filter: string) => {
    const { writer, events } = captureWriter();
    registerHandler(handlerId, writer);
    await createSubscription({
      resource: "cop_things",
      filter,
      handlerId,
      authId: null,
      scopeFilter: undefined,
    });
    return events;
  };

  it("does not throw on a tracked write when a subscription uses a custom operator, and delivers it", async () => {
    const tracked = trackMutations(db, {
      cop_things: { table: things, id: things.id, customOperators: { "=has=": hasOperator } },
    });

    const events = await openSub("h1", 'tags=has="red"');

    // The write must succeed — previously the fan-out compiled `tags=has="red"`
    // against a matcher with no custom operators and threw, failing the write.
    await expect(
      tracked.insert(things).values({ id: "t1", name: "Ball", tags: '["red","blue"]' }).returning()
    ).resolves.toBeDefined();

    const added = events.filter((e) => e.type === "added");
    expect(added.some((e) => e.object?.id === "t1")).toBe(true);

    await unregisterHandler("h1");
  });

  it("does not deliver to a non-matching custom-operator subscription", async () => {
    const tracked = trackMutations(db, {
      cop_things: { table: things, id: things.id, customOperators: { "=has=": hasOperator } },
    });

    const events = await openSub("h2", 'tags=has="green"');

    await tracked
      .insert(things)
      .values({ id: "t2", name: "Ball", tags: '["red","blue"]' })
      .returning();

    expect(events.filter((e) => e.type === "added")).toHaveLength(0);
    await unregisterHandler("h2");
  });

  it("reproduces the bug: without threaded custom operators the tracked write throws", async () => {
    // trackMutations registered WITHOUT customOperators (the pre-fix behavior).
    const tracked = trackMutations(db, {
      cop_things: { table: things, id: things.id },
    });

    await openSub("h3", 'tags=has="red"');

    await expect(
      tracked.insert(things).values({ id: "t3", name: "Ball", tags: '["red","blue"]' }).returning()
    ).rejects.toThrow(/operator/i);

    await unregisterHandler("h3");
  });
});
