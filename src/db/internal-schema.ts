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
