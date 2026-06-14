export {
  authSessions,
  authAccounts,
  authApiKeys,
  authVerificationTokens,
  authSessionsSqlite,
  authAccountsSqlite,
  authApiKeysSqlite,
  authVerificationTokensSqlite,
  authSessionsPg,
  authAccountsPg,
  authApiKeysPg,
  authVerificationTokensPg,
  internalSchema,
  internalSchemaSqlite,
  internalSchemaPg,
  INTERNAL_TABLE_NAMES,
  SESSION_KEYS,
  ACCOUNT_KEYS,
  API_KEY_KEYS,
  VERIFICATION_KEYS,
  defineInternalSchema,
  makeIdentityResolver,
} from "./internal-schema";
export type {
  InternalTableName,
  SessionKey,
  AccountKey,
  ApiKeyKey,
  VerificationKey,
  TableResolver,
  InternalTableOverride,
  InternalSchemaInput,
  InternalSchemaBundle,
} from "./internal-schema";

export { migrateInternal, autoMigrate, detectDialect } from "./migrate";
export type { Dialect, MigrateOptions, MigrationSummary } from "./migrate";

export { seed, createSeed, SeedBuilder } from "./seed";
export type {
  SeedOptions,
  SeedSummary,
  SeedTableSpec,
  SeedTableResult,
} from "./seed";

export { recommendedPoolConfig } from "./pooling";
export type { PoolDriver, PoolConfig } from "./pooling";
