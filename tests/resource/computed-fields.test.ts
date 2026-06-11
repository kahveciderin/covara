import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { createTestApp, get, post } from "../helpers/hono";

const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  firstName: text("firstName").notNull(),
  lastName: text("lastName").notNull(),
  secret: text("secret"),
});

describe("Computed / virtual fields", () => {
  let tempDir: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-computed-"));
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    await libsqlClient.execute(
      `CREATE TABLE people (id TEXT PRIMARY KEY, firstName TEXT NOT NULL, lastName TEXT NOT NULL, secret TEXT)`
    );
    app = createTestApp({ user: { id: "u" } });
    app.route(
      "/people",
      useResource(people, {
        id: people.id,
        db,
        fields: { readable: ["id", "firstName", "lastName"] },
        computed: {
          fullName: (row) => `${row.firstName} ${row.lastName}`,
        },
      })
    );
  });

  afterEach(() => {
    libsqlClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds computed fields to get/list responses and still masks hidden columns", async () => {
    await post(app, "/people", { id: "1", firstName: "Ada", lastName: "Lovelace", secret: "x" });

    const one = await get(app, "/people/1");
    expect(one.body.fullName).toBe("Ada Lovelace");
    expect(one.body).not.toHaveProperty("secret"); // masked

    const list = await get(app, "/people");
    expect(list.body.items[0].fullName).toBe("Ada Lovelace");
  });

  it("computes from the full row even when a source field is masked", async () => {
    // computed reads firstName/lastName (readable), result survives masking
    const res = await post(app, "/people", { id: "2", firstName: "Grace", lastName: "Hopper" });
    expect(res.body.fullName).toBe("Grace Hopper");
  });
});
