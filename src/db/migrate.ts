import { sql, getTableColumns, getTableName } from "drizzle-orm";
import type { DrizzleDatabase } from "@/resource/types";
import {
  INTERNAL_TABLE_NAMES,
  internalSchema,
  type InternalTableName,
  type InternalSchemaBundle,
  type TableResolver,
} from "./internal-schema";

export type Dialect = "sqlite" | "postgresql";

export interface MigrateOptions {
  dialect?: Dialect;
  /**
   * A bundle from `defineInternalSchema`. When supplied, migration is driven by
   * the bundle: `managedExternally: true` makes this a no-op (you run your own
   * migrations, e.g. drizzle-kit); otherwise DDL is generated from the supplied
   * tables (single-primary-key tables only — compound-PK customizations must use
   * `managedExternally: true`).
   */
  schema?: InternalSchemaBundle;
}

export interface MigrationSummary {
  dialect: Dialect;
  tables: string[];
  statements: number;
  skipped?: boolean;
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

const sqliteDDLByTable: Record<InternalTableName, string[]> = {
  auth_sessions: [
    `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    data TEXT
  )`,
    `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_sessions (userId)`,
    `CREATE INDEX IF NOT EXISTS auth_session_expiresAt_idx ON auth_sessions (expiresAt)`,
  ],
  auth_accounts: [
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
  ],
  auth_api_keys: [
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
  ],
  auth_verification_tokens: [
    `CREATE TABLE IF NOT EXISTS auth_verification_tokens (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires INTEGER NOT NULL,
    PRIMARY KEY (identifier, token)
  )`,
  ],
};

const postgresDDLByTable: Record<InternalTableName, string[]> = {
  auth_sessions: [
    `CREATE TABLE IF NOT EXISTS auth_sessions (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL,
    "data" TEXT
  )`,
    `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_sessions ("userId")`,
    `CREATE INDEX IF NOT EXISTS auth_session_expiresAt_idx ON auth_sessions ("expiresAt")`,
  ],
  auth_accounts: [
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
  ],
  auth_api_keys: [
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
  ],
  auth_verification_tokens: [
    `CREATE TABLE IF NOT EXISTS auth_verification_tokens (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP NOT NULL,
    PRIMARY KEY ("identifier", "token")
  )`,
  ],
};

const builtinDDL = (dialect: Dialect): string[] => {
  const byTable =
    dialect === "postgresql" ? postgresDDLByTable : sqliteDDLByTable;
  return INTERNAL_TABLE_NAMES.flatMap((name) => byTable[name]);
};

interface DrizzleColumn {
  name: string;
  notNull?: boolean;
  primary?: boolean;
  dataType?: string;
}

const sqlType = (column: DrizzleColumn, dialect: Dialect): string => {
  const dataType = column.dataType ?? "string";
  if (dialect === "postgresql") {
    switch (dataType) {
      case "number":
        return "INTEGER";
      case "boolean":
        return "BOOLEAN";
      case "date":
        return "TIMESTAMP";
      case "json":
        return "JSONB";
      default:
        return "TEXT";
    }
  }
  switch (dataType) {
    case "number":
    case "boolean":
    case "date":
      return "INTEGER";
    default:
      return "TEXT";
  }
};

const quote = (name: string, dialect: Dialect): string =>
  dialect === "postgresql" ? `"${name}"` : name;

// Generate a CREATE TABLE for a user-supplied (overridden) internal table.
// Only single-primary-key tables are supported; compound-PK customizations must
// use `managedExternally: true` + their own migration tool (indexes are not
// reconstructed here either).
const generateTableDDL = (
  resolver: TableResolver<string>,
  label: string,
  dialect: Dialect
): string => {
  const table = resolver.table;
  const tableName = getTableName(table as never);
  const columns = getTableColumns(table as never) as unknown as Record<
    string,
    DrizzleColumn
  >;
  const cols = Object.values(columns);
  const primaryCols = cols.filter((c) => c.primary);
  if (primaryCols.length !== 1) {
    throw new Error(
      `internalSchema.${label} ("${tableName}") has a compound or missing primary key, which generated migrations cannot reconstruct. Set internalSchema.managedExternally = true and create the table with your own migration tool (e.g. drizzle-kit).`
    );
  }
  const defs = cols.map((c) => {
    const parts = [quote(c.name, dialect), sqlType(c, dialect)];
    if (c.notNull) parts.push("NOT NULL");
    if (c.primary) parts.push("PRIMARY KEY");
    return parts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS ${quote(tableName, dialect)} (\n    ${defs.join(",\n    ")}\n  )`;
};

const isBuiltin = (resolver: TableResolver<string>, builtin: unknown): boolean =>
  (resolver.table as unknown) === builtin;

export const migrateInternal = async (
  db: DrizzleDatabase,
  options: MigrateOptions = {}
): Promise<MigrationSummary> => {
  const schema = options.schema;
  const dialect = options.dialect ?? schema?.dialect ?? detectDialect(db);

  // Mode (b): user manages migrations themselves.
  if (schema?.managedExternally) {
    return {
      dialect,
      tables: [
        getTableName(schema.sessions.table as never),
        getTableName(schema.accounts.table as never),
        getTableName(schema.apiKeys.table as never),
        getTableName(schema.verificationTokens.table as never),
      ],
      statements: 0,
      skipped: true,
    };
  }

  // Mode (a): no custom schema — run the built-in hardcoded DDL byte-for-byte.
  if (!schema) {
    const statements = builtinDDL(dialect);
    for (const statement of statements) {
      await runDDL(db, statement);
    }
    return {
      dialect,
      tables: [...INTERNAL_TABLE_NAMES],
      statements: statements.length,
    };
  }

  // Mode (c): generate DDL from the bundle. Built-in (non-overridden) tables
  // reuse their canonical DDL (with indexes/compound PKs); overrides are
  // generated from the table object.
  const builtins = internalSchema(dialect);
  const byTable =
    dialect === "postgresql" ? postgresDDLByTable : sqliteDDLByTable;
  const entries: Array<{
    resolver: TableResolver<string>;
    builtin: unknown;
    canonical: InternalTableName;
    label: string;
  }> = [
    {
      resolver: schema.sessions,
      builtin: builtins.authSessions,
      canonical: "auth_sessions",
      label: "sessions",
    },
    {
      resolver: schema.accounts,
      builtin: builtins.authAccounts,
      canonical: "auth_accounts",
      label: "accounts",
    },
    {
      resolver: schema.apiKeys,
      builtin: builtins.authApiKeys,
      canonical: "auth_api_keys",
      label: "apiKeys",
    },
    {
      resolver: schema.verificationTokens,
      builtin: builtins.authVerificationTokens,
      canonical: "auth_verification_tokens",
      label: "verificationTokens",
    },
  ];

  const statements: string[] = [];
  const tables: string[] = [];
  for (const entry of entries) {
    if (isBuiltin(entry.resolver, entry.builtin)) {
      statements.push(...byTable[entry.canonical]);
      tables.push(entry.canonical);
    } else {
      statements.push(generateTableDDL(entry.resolver, entry.label, dialect));
      tables.push(getTableName(entry.resolver.table as never));
    }
  }

  for (const statement of statements) {
    await runDDL(db, statement);
  }

  return { dialect, tables, statements: statements.length };
};

export const autoMigrate = async (
  db: DrizzleDatabase,
  options: MigrateOptions = {}
): Promise<MigrationSummary> => migrateInternal(db, options);
