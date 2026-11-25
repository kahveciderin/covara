import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { pushSchema } from "@/cli/drizzle-bridge";
import { migrateInternal } from "@/db/migrate";
import { defineInternalSchema } from "@/db/internal-schema";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { ResolvedProfile } from "@/cli/config";

const repoRoot = process.cwd();
const internalSchemaModule = path.join(repoRoot, "src", "db", "internal-schema.ts");

const APP_V1 = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const notes = sqliteTable("notes", { id: text("id").primaryKey(), body: text("body") });
`;

const APP_V2 = `${APP_V1}export const citationChecks = sqliteTable("citation_checks", { id: text("id").primaryKey() });
`;

const COVARA_SUBS_COLUMNS = `{
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  customerId: text("customerId").notNull(),
  account: text("account"),
  status: text("status").notNull(),
  priceId: text("priceId"),
  productId: text("productId"),
  quantity: integer("quantity"),
  currentPeriodStart: integer("currentPeriodStart"),
  currentPeriodEnd: integer("currentPeriodEnd"),
  cancelAtPeriodEnd: integer("cancelAtPeriodEnd"),
  trialEndsAt: integer("trialEndsAt"),
  metadata: text("metadata"),
  source: text("source"),
  updatedAt: integer("updatedAt").notNull(),
}`;

const covaraSubsTable = () =>
  sqliteTable("covara_billing_subscriptions", {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    customerId: text("customerId").notNull(),
    account: text("account"),
    status: text("status").notNull(),
    priceId: text("priceId"),
    productId: text("productId"),
    quantity: integer("quantity"),
    currentPeriodStart: integer("currentPeriodStart"),
    currentPeriodEnd: integer("currentPeriodEnd"),
    cancelAtPeriodEnd: integer("cancelAtPeriodEnd"),
    trialEndsAt: integer("trialEndsAt"),
    metadata: text("metadata"),
    source: text("source"),
    updatedAt: integer("updatedAt").notNull(),
  });

describe("covara push leaves Covara's internal tables alone", () => {
  let tmp: string;
  let profile: ResolvedProfile;
  let dbFile: string;

  const writeSchema = (content: string): string => {
    const p = path.join(tmp, "schema.ts");
    fs.writeFileSync(p, content);
    return p;
  };

  const tables = async (): Promise<string[]> => {
    const client = createClient({ url: `file:${dbFile}` });
    const res = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    client.close();
    return res.rows.map((r) => String(r.name));
  };

  const exec = async (sql: string): Promise<void> => {
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute(sql);
    client.close();
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(repoRoot, "tests", ".clitmp-"));
    dbFile = path.join(tmp, "app.db");
    profile = { name: "test", dialect: "sqlite", url: `file:${dbFile}` };
    const client = createClient({ url: `file:${dbFile}` });
    await migrateInternal(drizzle(client) as never);
    client.close();
    const first = await pushSchema(repoRoot, profile, writeSchema(APP_V1));
    expect(first.applied).toBe(true);
  }, 60000);

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("adds an app table without asking whether it renames an internal one (no TTY)", async () => {
    const result = await pushSchema(repoRoot, profile, writeSchema(APP_V2));
    expect(result.applied).toBe(true);
    expect(result.statementsToExecute.join("\n")).toMatch(/CREATE TABLE `citation_checks`/);
    expect(await tables()).toEqual(expect.arrayContaining(["citation_checks", "auth_passkeys", "billing_credit_entries"]));
  }, 60000);

  it("never drops an internal table the schema doesn't export, even one holding rows", async () => {
    await exec(
      "INSERT INTO auth_passkeys (id, userId, webauthnUserId, publicKey, counter, createdAt) VALUES ('p1', 'u1', 'w1', 'k', 0, 0)"
    );
    const result = await pushSchema(repoRoot, profile, writeSchema(APP_V1));
    expect(result.applied).toBe(true);
    expect(result.statementsToExecute).toEqual([]);
    expect(await tables()).toEqual(expect.arrayContaining(["auth_passkeys", "billing_credit_balances", "billing_subscriptions"]));
  }, 60000);

  it("still manages an internal table the schema exports", async () => {
    const withSessions = `${APP_V1}import { authSessionsSqlite } from ${JSON.stringify(internalSchemaModule)};
export const authSessions = authSessionsSqlite;
`;
    const result = await pushSchema(repoRoot, profile, writeSchema(withSessions));
    expect(result.statementsToExecute.join("\n")).not.toMatch(/auth_passkeys|billing_/);
    expect(result.statementsToExecute.join("\n")).not.toMatch(/DROP TABLE `auth_sessions`/);
  }, 60000);

  it("hides a renamed internal table when the schema exports its internal-schema bundle", async () => {
    const client = createClient({ url: `file:${dbFile}` });
    await migrateInternal(drizzle(client) as never, {
      schema: defineInternalSchema({ billingSubscriptions: { table: covaraSubsTable() as never } }),
    });
    client.close();
    expect(await tables()).toContain("covara_billing_subscriptions");

    const schema = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { defineInternalSchema } from ${JSON.stringify(internalSchemaModule)};
export const notes = sqliteTable("notes", { id: text("id").primaryKey(), body: text("body") });
export const citationChecks = sqliteTable("citation_checks", { id: text("id").primaryKey() });
const covaraSubs = sqliteTable("covara_billing_subscriptions", ${COVARA_SUBS_COLUMNS});
export const internalSchema = defineInternalSchema({ billingSubscriptions: { table: covaraSubs } });
`;
    const result = await pushSchema(repoRoot, profile, writeSchema(schema));
    expect(result.applied).toBe(true);
    expect(result.statementsToExecute.join("\n")).not.toMatch(/covara_billing_subscriptions/);
    expect(await tables()).toContain("covara_billing_subscriptions");
  }, 60000);
});

describe("push filter", () => {
  it("knows every internal table", async () => {
    const { COVARA_INTERNAL_TABLES } = await import("@/cli/push-filter");
    const { INTERNAL_TABLE_NAMES } = await import("@/db/internal-schema");
    expect([...COVARA_INTERNAL_TABLES].sort()).toEqual([...INTERNAL_TABLE_NAMES].sort());
  });

  it("hides on postgres through drizzle-kit's tablesFilter", async () => {
    const { postgresTablesFilter, unmanagedInternalTables } = await import("@/cli/push-filter");
    const { authSessionsPg } = await import("@/db/internal-schema");
    const hidden = unmanagedInternalTables({ authSessions: authSessionsPg });
    expect(hidden).not.toContain("auth_sessions");
    expect(postgresTablesFilter(hidden)).toContain("!auth_passkeys");
    expect(postgresTablesFilter([])).toBeUndefined();
  });
});
