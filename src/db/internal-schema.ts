import {
  sqliteTable,
  text as sqliteText,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  index as sqliteIndex,
} from "drizzle-orm/sqlite-core";
import {
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  jsonb as pgJsonb,
  primaryKey as pgPrimaryKey,
  index as pgIndex,
} from "drizzle-orm/pg-core";
import { getTableColumns, type AnyColumn } from "drizzle-orm";

export type InternalTableName =
  | "auth_sessions"
  | "auth_accounts"
  | "auth_api_keys"
  | "auth_verification_tokens";

export const INTERNAL_TABLE_NAMES: InternalTableName[] = [
  "auth_sessions",
  "auth_accounts",
  "auth_api_keys",
  "auth_verification_tokens",
];

export const authSessionsSqlite = sqliteTable(
  "auth_sessions",
  {
    id: sqliteText("id").primaryKey(),
    userId: sqliteText("userId").notNull(),
    createdAt: sqliteInteger("createdAt", { mode: "timestamp" }).notNull(),
    expiresAt: sqliteInteger("expiresAt", { mode: "timestamp" }).notNull(),
    data: sqliteText("data"),
  },
  (table) => ({
    userIdIdx: sqliteIndex("auth_session_userId_idx").on(table.userId),
    expiresAtIdx: sqliteIndex("auth_session_expiresAt_idx").on(table.expiresAt),
  })
);

export const authAccountsSqlite = sqliteTable(
  "auth_accounts",
  {
    userId: sqliteText("userId").notNull(),
    type: sqliteText("type").notNull(),
    provider: sqliteText("provider").notNull(),
    providerAccountId: sqliteText("providerAccountId").notNull(),
    refresh_token: sqliteText("refresh_token"),
    access_token: sqliteText("access_token"),
    expires_at: sqliteInteger("expires_at"),
    token_type: sqliteText("token_type"),
    scope: sqliteText("scope"),
    id_token: sqliteText("id_token"),
    session_state: sqliteText("session_state"),
  },
  (table) => ({
    compoundKey: sqlitePrimaryKey({
      columns: [table.provider, table.providerAccountId],
    }),
    userIdIdx: sqliteIndex("auth_account_userId_idx").on(table.userId),
  })
);

export const authApiKeysSqlite = sqliteTable(
  "auth_api_keys",
  {
    id: sqliteText("id").primaryKey(),
    userId: sqliteText("userId").notNull(),
    name: sqliteText("name").notNull(),
    keyHash: sqliteText("keyHash").notNull(),
    keyPrefix: sqliteText("keyPrefix").notNull(),
    scopes: sqliteText("scopes", { mode: "json" }).$type<string[]>(),
    createdAt: sqliteInteger("createdAt", { mode: "timestamp" }).notNull(),
    expiresAt: sqliteInteger("expiresAt", { mode: "timestamp" }),
    lastUsedAt: sqliteInteger("lastUsedAt", { mode: "timestamp" }),
    revokedAt: sqliteInteger("revokedAt", { mode: "timestamp" }),
  },
  (table) => ({
    userIdIdx: sqliteIndex("auth_api_key_userId_idx").on(table.userId),
    keyPrefixIdx: sqliteIndex("auth_api_key_prefix_idx").on(table.keyPrefix),
  })
);

export const authVerificationTokensSqlite = sqliteTable(
  "auth_verification_tokens",
  {
    identifier: sqliteText("identifier").notNull(),
    token: sqliteText("token").notNull(),
    expires: sqliteInteger("expires", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    compoundKey: sqlitePrimaryKey({
      columns: [table.identifier, table.token],
    }),
  })
);

export const authSessionsPg = pgTable(
  "auth_sessions",
  {
    id: pgText("id").primaryKey(),
    userId: pgText("userId").notNull(),
    createdAt: pgTimestamp("createdAt", { mode: "date" }).notNull(),
    expiresAt: pgTimestamp("expiresAt", { mode: "date" }).notNull(),
    data: pgText("data"),
  },
  (table) => ({
    userIdIdx: pgIndex("auth_session_userId_idx").on(table.userId),
    expiresAtIdx: pgIndex("auth_session_expiresAt_idx").on(table.expiresAt),
  })
);

export const authAccountsPg = pgTable(
  "auth_accounts",
  {
    userId: pgText("userId").notNull(),
    type: pgText("type").notNull(),
    provider: pgText("provider").notNull(),
    providerAccountId: pgText("providerAccountId").notNull(),
    refresh_token: pgText("refresh_token"),
    access_token: pgText("access_token"),
    expires_at: pgTimestamp("expires_at", { mode: "date" }),
    token_type: pgText("token_type"),
    scope: pgText("scope"),
    id_token: pgText("id_token"),
    session_state: pgText("session_state"),
  },
  (table) => ({
    compoundKey: pgPrimaryKey({
      columns: [table.provider, table.providerAccountId],
    }),
    userIdIdx: pgIndex("auth_account_userId_idx").on(table.userId),
  })
);

export const authApiKeysPg = pgTable(
  "auth_api_keys",
  {
    id: pgText("id").primaryKey(),
    userId: pgText("userId").notNull(),
    name: pgText("name").notNull(),
    keyHash: pgText("keyHash").notNull(),
    keyPrefix: pgText("keyPrefix").notNull(),
    scopes: pgJsonb("scopes").$type<string[]>(),
    createdAt: pgTimestamp("createdAt", { mode: "date" }).notNull(),
    expiresAt: pgTimestamp("expiresAt", { mode: "date" }),
    lastUsedAt: pgTimestamp("lastUsedAt", { mode: "date" }),
    revokedAt: pgTimestamp("revokedAt", { mode: "date" }),
  },
  (table) => ({
    userIdIdx: pgIndex("auth_api_key_userId_idx").on(table.userId),
    keyPrefixIdx: pgIndex("auth_api_key_prefix_idx").on(table.keyPrefix),
  })
);

export const authVerificationTokensPg = pgTable(
  "auth_verification_tokens",
  {
    identifier: pgText("identifier").notNull(),
    token: pgText("token").notNull(),
    expires: pgTimestamp("expires", { mode: "date" }).notNull(),
  },
  (table) => ({
    compoundKey: pgPrimaryKey({
      columns: [table.identifier, table.token],
    }),
  })
);

export const internalSchemaSqlite = {
  authSessions: authSessionsSqlite,
  authAccounts: authAccountsSqlite,
  authApiKeys: authApiKeysSqlite,
  authVerificationTokens: authVerificationTokensSqlite,
};

export const internalSchemaPg = {
  authSessions: authSessionsPg,
  authAccounts: authAccountsPg,
  authApiKeys: authApiKeysPg,
  authVerificationTokens: authVerificationTokensPg,
};

export const internalSchema = (dialect: "sqlite" | "postgresql") =>
  dialect === "postgresql" ? internalSchemaPg : internalSchemaSqlite;

export const authSessions = authSessionsSqlite;
export const authAccounts = authAccountsSqlite;
export const authApiKeys = authApiKeysSqlite;
export const authVerificationTokens = authVerificationTokensSqlite;

export const SESSION_KEYS = [
  "id",
  "userId",
  "createdAt",
  "expiresAt",
  "data",
] as const;
export type SessionKey = (typeof SESSION_KEYS)[number];
const SESSION_REQUIRED: readonly SessionKey[] = [
  "id",
  "userId",
  "createdAt",
  "expiresAt",
];

export const ACCOUNT_KEYS = [
  "userId",
  "type",
  "provider",
  "providerAccountId",
  "refresh_token",
  "access_token",
  "expires_at",
  "token_type",
  "scope",
  "id_token",
  "session_state",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
const ACCOUNT_REQUIRED: readonly AccountKey[] = [
  "userId",
  "type",
  "provider",
  "providerAccountId",
];

export const API_KEY_KEYS = [
  "id",
  "userId",
  "name",
  "keyHash",
  "keyPrefix",
  "scopes",
  "createdAt",
  "expiresAt",
  "lastUsedAt",
  "revokedAt",
] as const;
export type ApiKeyKey = (typeof API_KEY_KEYS)[number];
const API_KEY_REQUIRED: readonly ApiKeyKey[] = [
  "id",
  "userId",
  "name",
  "keyHash",
  "keyPrefix",
  "createdAt",
];

export const VERIFICATION_KEYS = ["identifier", "token", "expires"] as const;
export type VerificationKey = (typeof VERIFICATION_KEYS)[number];
const VERIFICATION_REQUIRED: readonly VerificationKey[] = [
  "identifier",
  "token",
  "expires",
];

type AnyTable = Record<string, unknown>;

export interface TableResolver<K extends string> {
  table: AnyTable;
  col(key: K): unknown;
  prop(key: K): string;
  dbName(key: K): string;
  has(key: K): boolean;
}

// A field can be remapped either by the table's property name (string) or, for
// type-safe/refactor-safe remapping, by passing the Drizzle column object itself
// (e.g. `fieldMap: { userId: mySessions.ownerId }`).
export type FieldRef = string | AnyColumn;

export interface InternalTableOverride<K extends string> {
  table: AnyTable;
  fieldMap?: Partial<Record<K, FieldRef>>;
}

const makeResolver = <K extends string>(
  table: AnyTable,
  required: readonly K[],
  label: string,
  fieldMap?: Partial<Record<K, FieldRef>>
): TableResolver<K> => {
  let columns: Record<string, { name?: string }> = {};
  try {
    columns = getTableColumns(table as never) as unknown as Record<
      string,
      { name?: string }
    >;
  } catch {
    columns = {};
  }
  const propByColumn = new Map<unknown, string>();
  for (const [p, column] of Object.entries(columns)) propByColumn.set(column, p);

  const propOf = (key: K): string => {
    const ref = fieldMap?.[key];
    if (ref == null) return key as string;
    if (typeof ref === "string") return ref;
    return propByColumn.get(ref) ?? (ref as { name?: string }).name ?? (key as string);
  };
  const colOf = (key: K): unknown => {
    const ref = fieldMap?.[key];
    if (ref != null && typeof ref !== "string") return ref;
    const p = propOf(key);
    return columns[p] ?? table[p];
  };
  const hasProp = (p: string): boolean =>
    columns[p] != null || table[p] != null;

  if (fieldMap) {
    for (const [key, ref] of Object.entries(fieldMap)) {
      if (ref != null && typeof ref !== "string" && !propByColumn.has(ref)) {
        throw new Error(
          `internalSchema.${label}.${key}: the supplied column does not belong to the given table.`
        );
      }
    }
  }

  for (const key of required) {
    const p = propOf(key);
    if (!hasProp(p)) {
      throw new Error(
        `internalSchema.${label}.${key}: required column not found on the supplied table (looked for property "${p}"). Map it via fieldMap.`
      );
    }
  }

  return {
    table,
    col: (key) => colOf(key),
    prop: (key) => propOf(key),
    dbName: (key) => columns[propOf(key)]?.name ?? propOf(key),
    has: (key) => hasProp(propOf(key)),
  };
};

export const makeIdentityResolver = <K extends string>(
  table: AnyTable,
  required: readonly K[],
  label = "table"
): TableResolver<K> => makeResolver(table, required, label);

export interface InternalSchemaInput {
  dialect?: "sqlite" | "postgresql";
  sessions?: InternalTableOverride<SessionKey>;
  accounts?: InternalTableOverride<AccountKey>;
  apiKeys?: InternalTableOverride<ApiKeyKey>;
  verificationTokens?: InternalTableOverride<VerificationKey>;
  managedExternally?: boolean;
}

export interface InternalSchemaBundle {
  dialect: "sqlite" | "postgresql";
  managedExternally: boolean;
  sessions: TableResolver<SessionKey>;
  accounts: TableResolver<AccountKey>;
  apiKeys: TableResolver<ApiKeyKey>;
  verificationTokens: TableResolver<VerificationKey>;
}

export const defineInternalSchema = (
  input: InternalSchemaInput = {}
): InternalSchemaBundle => {
  const dialect = input.dialect ?? "sqlite";
  const builtins = internalSchema(dialect);
  const resolve = <K extends string>(
    override: InternalTableOverride<K> | undefined,
    builtin: AnyTable,
    required: readonly K[],
    label: string
  ): TableResolver<K> =>
    makeResolver(
      override?.table ?? builtin,
      required,
      label,
      override?.fieldMap
    );

  return {
    dialect,
    managedExternally: input.managedExternally ?? false,
    sessions: resolve(
      input.sessions,
      builtins.authSessions as unknown as AnyTable,
      SESSION_REQUIRED,
      "sessions"
    ),
    accounts: resolve(
      input.accounts,
      builtins.authAccounts as unknown as AnyTable,
      ACCOUNT_REQUIRED,
      "accounts"
    ),
    apiKeys: resolve(
      input.apiKeys,
      builtins.authApiKeys as unknown as AnyTable,
      API_KEY_REQUIRED,
      "apiKeys"
    ),
    verificationTokens: resolve(
      input.verificationTokens,
      builtins.authVerificationTokens as unknown as AnyTable,
      VERIFICATION_REQUIRED,
      "verificationTokens"
    ),
  };
};
