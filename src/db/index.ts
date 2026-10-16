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
  authPasskeys,
  authPasskeysSqlite,
  authPasskeysPg,
  billingCreditEntriesSqlite,
  billingCreditBalancesSqlite,
  billingSubscriptionsSqlite,
  billingCreditEntriesPg,
  billingCreditBalancesPg,
  billingSubscriptionsPg,
  internalSchema,
  internalSchemaSqlite,
  internalSchemaPg,
  INTERNAL_TABLE_NAMES,
  SESSION_KEYS,
  ACCOUNT_KEYS,
  API_KEY_KEYS,
  VERIFICATION_KEYS,
  PASSKEY_KEYS,
  CREDIT_ENTRY_KEYS,
  CREDIT_BALANCE_KEYS,
  BILLING_SUBSCRIPTION_KEYS,
  defineInternalSchema,
  makeIdentityResolver,
} from "./internal-schema";
export type {
  InternalTableName,
  SessionKey,
  AccountKey,
  ApiKeyKey,
  VerificationKey,
  PasskeyKey,
  CreditEntryKey,
  CreditBalanceKey,
  BillingSubscriptionKey,
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
