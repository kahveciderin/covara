import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import { createResourceFilter } from "@/resource/filter";

// These exercise the SQL `convert()` path against a real SQLite database — the
// in-memory `execute()` path is covered in filter.test.ts.
const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  age: integer("age"),
});

describe("Filter → SQL conversion", () => {
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle>;
  let filter: ReturnType<typeof createResourceFilter>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    db = drizzle(client);
    await client.execute(
      "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)"
    );
    await client.execute(
      "INSERT INTO items (name, age) VALUES ('alice', 10), ('bob', 20), ('carol', 30), (NULL, 40)"
    );
    filter = createResourceFilter(items);
  });

  afterAll(() => client.close());

  const ids = async (expr: string): Promise<number[]> => {
    const rows = await db
      .select()
      .from(items)
      .where(filter.convert(expr) as SQL);
    return rows.map((r) => r.id).sort((a, b) => a - b);
  };

  const sqlOf = (expr: string): string =>
    db
      .select()
      .from(items)
      .where(filter.convert(expr) as SQL)
      .toSQL()
      .sql.toLowerCase();

  describe("null checks", () => {
    it("=isnull=true compiles to IS NULL and matches only null rows", async () => {
      expect(await ids("name=isnull=true")).toEqual([4]);
      expect(sqlOf("name=isnull=true")).toContain("is null");
      expect(sqlOf("name=isnull=true")).not.toContain("is not null");
    });

    it("=isnull=false compiles to IS NOT NULL and matches non-null rows", async () => {
      expect(await ids("name=isnull=false")).toEqual([1, 2, 3]);
      expect(sqlOf("name=isnull=false")).toContain("is not null");
    });

    it("==null compiles to IS NULL (not = NULL)", async () => {
      expect(await ids("name==null")).toEqual([4]);
      expect(sqlOf("name==null")).toContain("is null");
      expect(sqlOf("name==null")).not.toMatch(/=\s*null/);
    });

    it("!=null compiles to IS NOT NULL", async () => {
      expect(await ids("name!=null")).toEqual([1, 2, 3]);
      expect(sqlOf("name!=null")).toContain("is not null");
    });
  });

  describe("between", () => {
    it("=between= compiles to BETWEEN ? AND ? and matches the range", async () => {
      expect(await ids("age=between=[15,35]")).toEqual([2, 3]);
      expect(sqlOf("age=between=[15,35]")).toContain("between ? and ?");
    });

    it("=nbetween= compiles to NOT BETWEEN ? AND ?", async () => {
      expect(await ids("age=nbetween=[15,35]")).toEqual([1, 4]);
      expect(sqlOf("age=nbetween=[15,35]")).toContain("not between ? and ?");
    });
  });

  describe("=isempty=", () => {
    it("=isempty=true matches null-or-empty", async () => {
      // name is never empty-string here, but the null row qualifies.
      expect(await ids("name=isempty=true")).toEqual([4]);
    });
    it("=isempty=false matches non-empty values", async () => {
      expect(await ids("name=isempty=false")).toEqual([1, 2, 3]);
    });
  });
});
