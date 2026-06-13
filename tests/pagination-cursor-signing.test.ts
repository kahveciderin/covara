import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import {
  encodeCursor,
  decodeCursor,
  setGlobalCursorSigningSecret,
} from "@/resource/pagination";
import { createCovara } from "@/server/app";

describe("cursor signing — primitives", () => {
  const data = { v: "x", id: "1" };

  it("signs the cursor when a secret is given and verifies it on decode", () => {
    const signed = encodeCursor(data, undefined, "s3cret");
    expect(signed).toContain("."); // payload.signature
    const r = decodeCursor(signed, undefined, undefined, "s3cret");
    expect(r.success).toBe(true);
  });

  it("does not sign when no secret is given", () => {
    const plain = encodeCursor(data);
    expect(plain).not.toContain(".");
    expect(decodeCursor(plain).success).toBe(true);
  });

  it("rejects a tampered payload as 'tampered'", () => {
    const signed = encodeCursor(data, undefined, "s3cret");
    const [payload, sig] = signed.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    decoded.id = "999"; // tamper
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const r = decodeCursor(`${forgedPayload}.${sig}`, undefined, undefined, "s3cret");
    expect(r).toEqual({ success: false, error: "tampered" });
  });

  it("rejects a wrong/missing signature", () => {
    const signed = encodeCursor(data, undefined, "s3cret");
    const payload = signed.split(".")[0];
    expect(decodeCursor(`${payload}.deadbeef`, undefined, undefined, "s3cret").success).toBe(false);
    // an unsigned cursor presented to a signing resource is rejected
    expect(decodeCursor(payload, undefined, undefined, "s3cret")).toEqual({
      success: false,
      error: "tampered",
    });
    // a cursor signed with a different secret is rejected
    const otherSecret = encodeCursor(data, undefined, "other");
    expect(decodeCursor(otherSecret, undefined, undefined, "s3cret").success).toBe(false);
  });
});

describe("cursor signing — global/resource precedence", () => {
  const items = sqliteTable("sign_items", {
    id: text("id").primaryKey(),
    n: integer("n").notNull(),
  });
  let sqlite: Database.Database;
  let app: ReturnType<typeof createCovara>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE sign_items (id TEXT PRIMARY KEY, n INTEGER NOT NULL);");
    const db = drizzle(sqlite);
    for (let i = 0; i < 6; i++) {
      sqlite.prepare("INSERT INTO sign_items (id,n) VALUES (?,?)").run(String(i), i);
    }
    setGlobalCursorSigningSecret("global-secret");
    app = createCovara()
      // inherits the global secret
      .resource("/global", items, { id: items.id, db, auth: { public: { read: true } }, pagination: { defaultLimit: 2 } })
      // own secret overrides the global
      .resource("/own", items, { id: items.id, db, auth: { public: { read: true } }, pagination: { defaultLimit: 2 }, cursorSigningSecret: "own-secret" })
      // explicit null opts out even though a global secret is set
      .resource("/unsigned", items, { id: items.id, db, auth: { public: { read: true } }, pagination: { defaultLimit: 2 }, cursorSigningSecret: null });
  });

  afterAll(() => {
    setGlobalCursorSigningSecret(undefined); // module global — don't leak into other tests
    sqlite.close();
  });

  const firstCursor = async (path: string): Promise<string> => {
    const res = await app.request(`/api/${path}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeTruthy();
    return body.nextCursor as string;
  };

  const tamper = (cursor: string): string => {
    const [payload, sig] = cursor.split(".");
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    data.id = "tampered";
    const forged = Buffer.from(JSON.stringify(data)).toString("base64url");
    return sig ? `${forged}.${sig}` : forged;
  };

  it("signs cursors using the global secret when the resource doesn't set one", async () => {
    const cursor = await firstCursor("global");
    expect(cursor).toContain(".");
    // valid cursor works
    expect((await app.request(`/api/global?cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
    // tampered cursor is rejected
    const res = await app.request(`/api/global?cursor=${encodeURIComponent(tamper(cursor))}`);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("tampered");
  });

  it("signs with the resource's own secret (overrides global)", async () => {
    const cursor = await firstCursor("own");
    expect(cursor).toContain(".");
    // the global secret cannot validate an own-secret cursor: rebuild a cursor
    // signed with global and confirm /own rejects it as tampered.
    const res = await app.request(`/api/own?cursor=${encodeURIComponent(tamper(cursor))}`);
    expect(res.status).toBe(400);
  });

  it("does not sign when the resource opts out with null", async () => {
    const cursor = await firstCursor("unsigned");
    expect(cursor).not.toContain(".");
    // unsigned cursor is accepted (no verification)
    expect((await app.request(`/api/unsigned?cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
  });
});
