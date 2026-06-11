import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "@/resource/types";
import { INTERNAL_TABLE_NAMES, type InternalTableName } from "./internal-schema";

export type Dialect = "sqlite" | "postgresql";

export interface MigrateOptions {
  dialect?: Dialect;
}

export interface MigrationSummary {
  dialect: Dialect;
  tables: InternalTableName[];
  statements: number;
}

export const detectDialect = (db: DrizzleDatabase): Dialect => {
  const name: string =
    (db as { dialect?: { constructor?: { name?: string } } }).dialect
      ?.constructor?.name ?? "";
  if (/pg|postgres/i.test(name)) return "postgresql";
  return "sqlite";
};

const runDDL = async (db: DrizzleDatabase, statement: string): Promise<void> => {
  const query = sql.raw(statement);
  if (typeof (db as { run?: unknown }).run === "function") {
    await (db as { run: (q: unknown) => Promise<unknown> }).run(query);
    return;
  }
  if (typeof (db as { execute?: unknown }).execute === "function") {
    await (db as { execute: (q: unknown) => Promise<unknown> }).execute(query);
    return;
  }
  throw new Error("Drizzle db exposes neither run() nor execute()");
};

const sqliteDDL: string[] = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    data TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_sessions (userId)`,
  `CREATE INDEX IF NOT EXISTS auth_session_expiresAt_idx ON auth_sessions (expiresAt)`,
  `CREATE TABLE IF NOT EXISTS auth_accounts (
    userId TEXT NOT NULL,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    refresh_token TEXT,
    access_token TEXT,
    expires_at INTEGER,
    token_type TEXT,
    scope TEXT,
    id_token TEXT,
    session_state TEXT,
    PRIMARY KEY (provider, providerAccountId)
  )`,
  `CREATE INDEX IF NOT EXISTS auth_account_userId_idx ON auth_accounts (userId)`,
  `CREATE TABLE IF NOT EXISTS auth_api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    keyHash TEXT NOT NULL,
    keyPrefix TEXT NOT NULL,
    scopes TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER,
    lastUsedAt INTEGER,
    revokedAt INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS auth_api_key_userId_idx ON auth_api_keys (userId)`,
  `CREATE INDEX IF NOT EXISTS auth_api_key_prefix_idx ON auth_api_keys (keyPrefix)`,
  `CREATE TABLE IF NOT EXISTS auth_verification_tokens (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires INTEGER NOT NULL,
    PRIMARY KEY (identifier, token)
  )`,
];

const postgresDDL: string[] = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL,
    "data" TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_sessions ("userId")`,
  `CREATE INDEX IF NOT EXISTS auth_session_expiresAt_idx ON auth_sessions ("expiresAt")`,
  `CREATE TABLE IF NOT EXISTS auth_accounts (
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" TIMESTAMP,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    PRIMARY KEY ("provider", "providerAccountId")
  )`,
  `CREATE INDEX IF NOT EXISTS auth_account_userId_idx ON auth_accounts ("userId")`,
  `CREATE TABLE IF NOT EXISTS auth_api_keys (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" JSONB,
    "createdAt" TIMESTAMP NOT NULL,
    "expiresAt" TIMESTAMP,
    "lastUsedAt" TIMESTAMP,
    "revokedAt" TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS auth_api_key_userId_idx ON auth_api_keys ("userId")`,
  `CREATE INDEX IF NOT EXISTS auth_api_key_prefix_idx ON auth_api_keys ("keyPrefix")`,
  `CREATE TABLE IF NOT EXISTS auth_verification_tokens (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP NOT NULL,
    PRIMARY KEY ("identifier", "token")
  )`,
];

export const migrateInternal = async (
  db: DrizzleDatabase,
  options: MigrateOptions = {}
): Promise<MigrationSummary> => {
  const dialect = options.dialect ?? detectDialect(db);
  const statements = dialect === "postgresql" ? postgresDDL : sqliteDDL;

  for (const statement of statements) {
    await runDDL(db, statement);
  }

  return {
    dialect,
    tables: [...INTERNAL_TABLE_NAMES],
    statements: statements.length,
  };
};

export const autoMigrate = async (
  db: DrizzleDatabase,
  options: MigrateOptions = {}
): Promise<MigrationSummary> => migrateInternal(db, options);
