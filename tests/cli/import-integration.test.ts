import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pushSchema, importRows, queryData } from "@/cli/drizzle-bridge";
import type { ResolvedProfile } from "@/cli/config";

const repoRoot = process.cwd();
const SCHEMA = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const items = sqliteTable("imp_cli_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
`;

describe("CLI import round-trip (worker insert op)", () => {
  let tmp: string;
  let profile: ResolvedProfile;
  let schemaPath: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(repoRoot, "tests", ".clitmp-imp-"));
    profile = { name: "t", dialect: "sqlite", url: `file:${path.join(tmp, "t.db")}` };
    schemaPath = path.join(tmp, "schema.ts");
    fs.writeFileSync(schemaPath, SCHEMA);
    await pushSchema(repoRoot, profile, schemaPath);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("imports rows and reads them back", async () => {
    const result = await importRows(repoRoot, profile, schemaPath, "items", [
      { name: "alpha" },
      { name: "beta" },
    ]);
    expect(result.inserted).toBe(2);

    const { rows } = await queryData(repoRoot, profile, schemaPath, "items", { limit: 100 });
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  }, 60000);
});
