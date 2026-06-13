import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { pushSchema, queryData, isDestructive } from "@/cli/drizzle-bridge";
import type { ResolvedProfile } from "@/cli/config";

const repoRoot = process.cwd();
const SCHEMA_V1 = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const items = sqliteTable("cli_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
`;
const SCHEMA_V2 = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const items = sqliteTable("cli_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
});
`;
const SCHEMA_V3 = `import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
export const items = sqliteTable("cli_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
});
`;

describe("CLI push (drizzle-kit bridge via tsx worker)", () => {
  let tmp: string;
  let dbUrl: string;
  let profile: ResolvedProfile;

  const writeSchema = (content: string): string => {
    const p = path.join(tmp, "schema.ts");
    fs.writeFileSync(p, content);
    return p;
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(repoRoot, "tests", ".clitmp-"));
    dbUrl = `file:${path.join(tmp, "test.db")}`;
    profile = { name: "test", dialect: "sqlite", url: dbUrl };
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("auto-applies an additive create-table push", async () => {
    const schemaPath = writeSchema(SCHEMA_V1);
    const result = await pushSchema(repoRoot, profile, schemaPath);
    expect(result.applied).toBe(true);
    expect(result.statementsToExecute.join("\n")).toMatch(/create table/i);
    expect(isDestructive(result)).toBe(false);
  }, 60000);

  it("round-trips data through the worker", async () => {
    const client = createClient({ url: dbUrl });
    await client.execute("INSERT INTO cli_items (name) VALUES ('alpha')");
    client.close();
    const schemaPath = writeSchema(SCHEMA_V1);
    const { rows } = await queryData(repoRoot, profile, schemaPath, "items", { limit: 10 });
    expect(rows.length).toBe(1);
    expect((rows[0] as any).name).toBe("alpha");
  }, 60000);

  it("auto-applies an additive add-column push", async () => {
    const schemaPath = writeSchema(SCHEMA_V2);
    const result = await pushSchema(repoRoot, profile, schemaPath);
    expect(result.applied).toBe(true);
    expect(result.statementsToExecute.join("\n")).toMatch(/add column|alter table/i);
  }, 60000);

  it("refuses a destructive push without --force, then applies with force", async () => {
    const schemaPath = writeSchema(SCHEMA_V3);
    const unforced = await pushSchema(repoRoot, profile, schemaPath);
    expect(unforced.applied).toBe(false);
    expect(isDestructive(unforced)).toBe(true);

    const forced = await pushSchema(repoRoot, profile, schemaPath, { force: true });
    expect(forced.applied).toBe(true);
  }, 60000);
});
