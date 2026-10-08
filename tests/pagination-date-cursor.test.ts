import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createCovara } from "@/server/app";

describe("cursor pagination ordered by a timestamp column", () => {
  const events = sqliteTable("date_cursor_events", {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
  });
  const DAY = 86_400;
  const START = 1_700_000_000;
  let sqlite: Database.Database;
  let app: ReturnType<typeof createCovara>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE date_cursor_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);"
    );
    const insert = sqlite.prepare("INSERT INTO date_cursor_events (id, created_at, seen_at) VALUES (?,?,?)");
    // Rows 2 and 3 share a createdAt, so a page boundary falls on a tie.
    for (let i = 0; i < 7; i++) {
      const created = START + (i === 3 ? 2 : i) * DAY;
      insert.run(`e${i}`, created, (START - i * DAY) * 1000);
    }
    app = createCovara().resource("/events", events, {
      id: events.id,
      db: drizzle(sqlite),
      auth: { public: { read: true } },
    });
  });

  afterAll(() => sqlite.close());

  const walk = async (orderBy: string, limit: number): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ orderBy, limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      const res = await app.request(`/api/events?${query}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      ids.push(...body.items.map((item: { id: string }) => item.id));
      cursor = body.nextCursor;
    } while (cursor);
    return ids;
  };

  it("walks every page, newest first", async () => {
    expect(await walk("-createdAt", 3)).toEqual(["e6", "e5", "e4", "e2", "e3", "e1", "e0"]);
  });

  it("walks every page, oldest first, across a tie", async () => {
    expect(await walk("createdAt:asc", 3)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6"]);
  });

  it("walks a millisecond timestamp", async () => {
    expect(await walk("seenAt:asc", 2)).toEqual(["e6", "e5", "e4", "e3", "e2", "e1", "e0"]);
  });
});
