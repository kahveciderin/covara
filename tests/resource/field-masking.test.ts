import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sql } from "drizzle-orm";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post, patch } from "../helpers/hono";

const usersTable = sqliteTable("masked_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  isAdmin: integer("isAdmin", { mode: "boolean" }).notNull().default(false),
});

describe("Field-level read masking", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-mask-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(`
      CREATE TABLE masked_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        isAdmin INTEGER NOT NULL DEFAULT 0
      )
    `);

    app = createTestApp({ user: { id: "u" } });
    app.route(
      "/users",
      useResource(usersTable, {
        id: usersTable.id,
        db,
        fields: { readable: ["id", "name", "email"] },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seed = () =>
    post(app, "/users", {
      id: "1",
      name: "Alice",
      email: "a@test.com",
      passwordHash: "secret-hash",
      isAdmin: true,
    });

  it("strips non-readable columns from the create response", async () => {
    const res = await seed();
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Alice");
    expect(res.body).not.toHaveProperty("passwordHash");
    expect(res.body).not.toHaveProperty("isAdmin");
  });

  it("strips non-readable columns from get and list", async () => {
    await seed();

    const one = await get(app, "/users/1");
    expect(one.body.email).toBe("a@test.com");
    expect(one.body).not.toHaveProperty("passwordHash");

    const list = await get(app, "/users");
    expect(list.body.items[0]).not.toHaveProperty("passwordHash");
    expect(list.body.items[0]).not.toHaveProperty("isAdmin");
    expect(list.body.items[0].name).toBe("Alice");
  });

  it("strips non-readable columns from update responses", async () => {
    await seed();
    const res = await patch(app, "/users/1", { name: "Alice 2" });
    expect(res.body.name).toBe("Alice 2");
    expect(res.body).not.toHaveProperty("passwordHash");
  });

  it("cannot be bypassed via select projection of a hidden field", async () => {
    await seed();
    const res = await get(app, "/users/1?select=id,passwordHash");
    expect(res.body).not.toHaveProperty("passwordHash");
  });
});
