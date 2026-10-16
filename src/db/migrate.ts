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
  auth_passkeys: [
    `CREATE TABLE IF NOT EXISTS auth_passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL,
    webauthnUserId TEXT NOT NULL,
    publicKey TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    deviceType TEXT,
    backedUp INTEGER,
    name TEXT,
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER
  )`,
    `CREATE INDEX IF NOT EXISTS auth_passkey_userId_idx ON auth_passkeys (userId)`,
  ],
  billing_credit_entries: [
    `CREATE TABLE IF NOT EXISTS billing_credit_entries (
    id TEXT PRIMARY KEY NOT NULL,
    account TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balanceAfter INTEGER NOT NULL,
    reason TEXT,
    metadata TEXT,
    idempotencyKey TEXT,
    createdAt INTEGER NOT NULL
  )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS billing_credit_entries_account_seq_uq ON billing_credit_entries (account, seq)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS billing_credit_entries_account_idem_uq ON billing_credit_entries (account, idempotencyKey)`,
  ],
  billing_credit_balances: [
    `CREATE TABLE IF NOT EXISTS billing_credit_balances (
    account TEXT PRIMARY KEY NOT NULL,
    balance INTEGER NOT NULL,
    version INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  ],
  billing_subscriptions: [
    `CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    customerId TEXT NOT NULL,
    account TEXT,
    status TEXT NOT NULL,
    priceId TEXT,
    productId TEXT,
    quantity INTEGER,
    currentPeriodStart INTEGER,
    currentPeriodEnd INTEGER,
    cancelAtPeriodEnd INTEGER,
    trialEndsAt INTEGER,
    metadata TEXT,
    source TEXT,
    updatedAt INTEGER NOT NULL
  )`,
    `CREATE INDEX IF NOT EXISTS billing_subscriptions_customer_idx ON billing_subscriptions (customerId)`,
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
  auth_passkeys: [
    `CREATE TABLE IF NOT EXISTS auth_passkeys (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL,
    "webauthnUserId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL,
    "transports" JSONB,
    "deviceType" TEXT,
    "backedUp" BOOLEAN,
    "name" TEXT,
    "createdAt" TIMESTAMP NOT NULL,
    "lastUsedAt" TIMESTAMP
  )`,
    `CREATE INDEX IF NOT EXISTS auth_passkey_userId_idx ON auth_passkeys ("userId")`,
  ],
  billing_credit_entries: [
    `CREATE TABLE IF NOT EXISTS billing_credit_entries (
    "id" TEXT PRIMARY KEY NOT NULL,
    "account" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL
  )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS billing_credit_entries_account_seq_uq ON billing_credit_entries ("account", "seq")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS billing_credit_entries_account_idem_uq ON billing_credit_entries ("account", "idempotencyKey")`,
  ],
  billing_credit_balances: [
    `CREATE TABLE IF NOT EXISTS billing_credit_balances (
    "account" TEXT PRIMARY KEY NOT NULL,
    "balance" BIGINT NOT NULL,
    "version" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  ],
  billing_subscriptions: [
    `CREATE TABLE IF NOT EXISTS billing_subscriptions (
    "id" TEXT PRIMARY KEY NOT NULL,
    "provider" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "account" TEXT,
    "status" TEXT NOT NULL,
    "priceId" TEXT,
    "productId" TEXT,
    "quantity" BIGINT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN,
    "trialEndsAt" TIMESTAMP(3),
    "metadata" JSONB,
    "source" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
    `CREATE INDEX IF NOT EXISTS billing_subscriptions_customer_idx ON billing_subscriptions ("customerId")`,
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
  columnType?: string;
}

const sqlType = (column: DrizzleColumn, dialect: Dialect): string => {
  const dataType = column.dataType ?? "string";
  if (dialect === "postgresql") {
    if (column.columnType?.includes("BigInt")) return "BIGINT";
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

// The credits ledger relies on these unique indexes for its optimistic
// concurrency (account, seq) and idempotency (account, idempotencyKey)
// guarantees, so they are reconstructed for overridden tables too.
const overrideIndexDDL = (
  resolver: TableResolver<string>,
  canonical: InternalTableName,
  dialect: Dialect
): string[] => {
  const tableName = getTableName(resolver.table as never);
  const q = (name: string): string => quote(name, dialect);
  const on = (...keys: string[]): string =>
    `${q(tableName)} (${keys.map((k) => q(resolver.dbName(k))).join(", ")})`;
  if (canonical === "billing_credit_entries") {
    return [
      `CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_account_seq_uq ON ${on("account", "seq")}`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_account_idem_uq ON ${on("account", "idempotencyKey")}`,
    ];
  }
  if (canonical === "billing_subscriptions") {
    return [`CREATE INDEX IF NOT EXISTS ${tableName}_customer_idx ON ${on("customerId")}`];
  }
  return [];
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
        getTableName(schema.passkeys.table as never),
        getTableName(schema.creditEntries.table as never),
        getTableName(schema.creditBalances.table as never),
        getTableName(schema.billingSubscriptions.table as never),
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
    {
      resolver: schema.passkeys,
      builtin: builtins.authPasskeys,
      canonical: "auth_passkeys",
      label: "passkeys",
    },
    {
      resolver: schema.creditEntries,
      builtin: builtins.billingCreditEntries,
      canonical: "billing_credit_entries",
      label: "creditEntries",
    },
    {
      resolver: schema.creditBalances,
      builtin: builtins.billingCreditBalances,
      canonical: "billing_credit_balances",
      label: "creditBalances",
    },
    {
      resolver: schema.billingSubscriptions,
      builtin: builtins.billingSubscriptions,
      canonical: "billing_subscriptions",
      label: "billingSubscriptions",
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
      statements.push(...overrideIndexDDL(entry.resolver, entry.canonical, dialect));
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
