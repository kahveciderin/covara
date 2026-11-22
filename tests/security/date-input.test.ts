import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core";
import { useResource } from "@/resource/hook";
import { createDateInputParser } from "@/resource/input";
import { createTestApp, request } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const events = sqliteTable("di_events", {
  id: text("id").primaryKey(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  endsAt: integer("endsAt", { mode: "timestamp_ms" }),
  label: text("label"),
});
const pgEvents = pgTable("di_pg_events", {
  id: pgText("id").primaryKey(),
  at: timestamp("at"),
  many: timestamp("many").array(),
  raw: timestamp("raw", { mode: "string" }),
});

const ISO = "2026-11-22T10:00:00.000Z";

describe("date columns accept ISO strings from JSON", () => {
  let t: TempDb;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    t = await openTempDb(`
      CREATE TABLE di_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, endsAt INTEGER, label TEXT);
      INSERT INTO di_events VALUES ('e1', 0, 5, NULL);
    `);
    app = createTestApp({ user: { id: "u1" } });
    app.route("/events", useResource(events, { id: events.id, db: t.db, strictInput: true }));
  });
  afterEach(() => t.close());

  it.each([
    ["POST", "/events", { id: "e2", at: ISO }],
    ["POST", "/events/batch", { items: [{ id: "e2", at: ISO }] }],
    ["POST", "/events/batch/upsert", { items: [{ id: "e1", at: ISO }] }],
    ["PUT", "/events/e1", { id: "e1", at: ISO }],
    ["PATCH", "/events/e1", { at: ISO }],
    ["PATCH", "/events/batch", { at: ISO }],
  ])("%s %s stores the instant", async (method, path, body) => {
    expect((await request(app, method, path, body)).status).toBeLessThan(300);
    const stored = (await t.client.execute("SELECT at FROM di_events")).rows.map((r) => Number(r.at));
    expect(stored).toContain(Date.parse(ISO));
  });

  it.each([
    ["2026-11-22", "2026-11-22T00:00:00.000Z"],
    ["2026-11-22T10:00Z", ISO],
    ["2026-11-22T13:00:00+03:00", ISO],
    ["2026-11-22T10:00:00.000000Z", ISO],
    ["2028-02-29", "2028-02-29T00:00:00.000Z"],
  ])("accepts %s", async (input, expected) => {
    const res = await request(app, "PATCH", "/events/e1", { at: input });
    expect(res.status).toBe(200);
    expect(res.body.at).toBe(expected);
  });

  it.each([
    "",
    "1",
    "tomorrow",
    "2026-02-30",
    "2026-02-29",
    "2026-13-01",
    "2026-11-22T24:00:00Z",
    "2026-11-22T10:00:00",
    "2026-11-22T10:00:00+25:00",
    " 2026-11-22",
    true,
    0,
    null,
  ])("rejects %j for a required date", async (input) => {
    expect((await request(app, "PATCH", "/events/e1", { at: input })).status).toBe(400);
  });

  it("keeps null as null for a nullable date", async () => {
    const res = await request(app, "PATCH", "/events/e1", { endsAt: null });
    expect(res.status).toBe(200);
    expect(res.body.endsAt).toBeNull();
  });

  it("leaves ISO-looking text columns as text", async () => {
    expect((await request(app, "PATCH", "/events/e1", { label: ISO })).body.label).toBe(ISO);
  });

  it("round-trips a fetched row through PUT", async () => {
    const row = (await request(app, "GET", "/events/e1")).body;
    expect((await request(app, "PUT", "/events/e1", row)).status).toBe(200);
  });

  it("handles Postgres timestamps and timestamp arrays, and leaves string mode alone", () => {
    const parse = createDateInputParser(pgEvents);
    expect(parse({ at: ISO, many: [ISO, null], raw: ISO })).toEqual({
      at: new Date(ISO),
      many: [new Date(ISO), null],
      raw: ISO,
    });
  });

  it.each([null, "text", 3, [ISO]])("passes a non-object body %j through", (body) => {
    expect(createDateInputParser(events)(body)).toEqual(body);
  });
});
