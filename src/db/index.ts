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
} from "./internal-schema";
export type { InternalTableName } from "./internal-schema";

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
