// Main server-side exports for Covara

// App factory
export { createCovara, CovaraApp } from "./server/app";
export type { CovaraOptions, CovaraAuthSetup } from "./server/app";

// Resource (core)
export { useResource } from "./resource/hook";
export { createResourceFilter, type Filter } from "./resource/filter";
export { changelog, recordCreate, recordUpdate, recordDelete } from "./resource/changelog";
export {
  encodeCursor,
  decodeCursor,
  parseOrderBy,
  createPagination,
  setGlobalCursorSigningSecret,
  getGlobalCursorSigningSecret,
  type CursorData,
  type PaginationConfig,
  type OrderByField,
} from "./resource/pagination";
export {
  ResourceError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  PowRequiredError,
  CaptchaRequiredError,
  BatchLimitError,
  ConflictError,
  SearchError,
  SearchNotConfiguredError,
  formatErrorResponse,
  formatZodError,
} from "./resource/error";
export type {
  ResourceConfig,
  ScopeConfig,
  ScopeFunction,
  BatchConfig,
  CustomOperator,
  LifecycleHooks,
  ProcedureDefinition,
  ProcedureContext,
  WriteEffect,
} from "./resource/types";
export {
  columnName,
  columnNames,
  type ColumnRef,
  type ResourceConfigInput,
  type ETagResourceConfigInput,
  type FieldPoliciesInput,
  type FilterConfigInput,
  type ResourceSearchConfigInput,
  type SoftDeleteConfigInput,
  type RelationConfigInput,
  type RelationsConfigInput,
} from "./resource/column-ref";

// Subscriptions
export {
  createSubscription as createServerSubscription,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  clearAllSubscriptions,
  type RelationLoader,
} from "./resource/subscription";

// Procedures
export {
  defineProcedure,
  procedureBuilder,
  executeProcedure,
  createTimestampHooks,
  composeHooks,
} from "./resource/procedures";

// Query utilities
export { parseSelect, applyProjection } from "./resource/query";

// Auth
export {
  rsql,
  allScope,
  emptyScope,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inList,
  notIn,
  like,
  notLike,
  isNull,
  isNotNull,
  and,
  or,
  ownerScope,
  publicScope,
  ownerOrPublic,
  isCompiledScope,
  scopeFromString,
} from "./auth/rsql";
export {
  BaseAuthAdapter,
  CompositeAuthAdapter,
  NullAuthAdapter,
  createUserContext,
} from "./auth/adapter";
export {
  createAuthMiddleware,
  requireAuth,
  optionalAuth,
  requireRole,
  requirePermission,
  getUser,
  rateByUser,
} from "./auth/middleware";
export {
  ScopeResolver,
  createScopeResolver,
  combineScopes,
  checkObjectAccess,
  scopePatterns,
  type Operation,
} from "./auth/scope";
export { createPassportAdapter } from "./auth/adapters/passport";
export {
  fromPassport,
  normalizePassportProfile,
  installFetchTransport,
} from "./auth/passport-bridge";
export type {
  SocialProvider,
  SocialAccount,
  NormalizedProfile,
  FromPassportOptions,
  PassportStrategyLike,
} from "./auth/passport-bridge";
export { createKvSocialStateStore } from "./auth/social";
export type { SocialAuthOptions, SocialStateStore } from "./auth/social";
export { cookieSession, jwtSession, fromAuthAdapter } from "./auth/session";
export type {
  SessionStrategy,
  SessionUser,
  IssuedSession,
  CookieSessionOptions,
  JwtSessionOptions,
} from "./auth/session";
export { createAuthJsAdapter } from "./auth/adapters/authjs";
export { createJWTAdapter } from "./auth/adapters/jwt";
export type { JWTConfig, JWTAdapterOptions } from "./auth/adapters/jwt";
export { createAuthAdapter, createSessionStore } from "./auth/config";
export type { AuthMode, AuthConfig, AuthConfigUser, SessionStoreConfig } from "./auth/config";
export { hashPassword, verifyPassword, needsRehash } from "./auth/password";
export type { PasswordHashOptions } from "./auth/password";
export {
  createCsrfMiddleware,
  issueCsrfToken,
  generateCsrfToken,
  LoginThrottle,
  InMemoryVerificationTokenStore,
  KVVerificationTokenStore,
  createKVVerificationTokenStore,
  issueToken,
  verifyToken,
  issuePasswordResetToken,
  verifyPasswordResetToken,
  hashNewPassword,
} from "./auth";
export type {
  CsrfOptions,
  LoginThrottleOptions,
  ThrottleCheck,
  VerificationTokenStore,
  VerificationTokenRecord,
  PasswordResetOptions,
} from "./auth";
export { useAuth, createAuthRoutes } from "./auth/routes";
export type { UseAuthOptions, AuthRouterResult, AuthUser } from "./auth/routes";
export { InMemorySessionStore } from "./auth/types";
export type {
  AuthCredentials,
  AuthResult,
  SessionData,
  ApiKeyData,
  AuthAdapter,
  ResourceAuthConfig,
  AuthMiddlewareOptions,
  SessionStore,
} from "./auth/types";

// Abuse protection (token-bucket budget + proof-of-work)
export {
  abuseProtection,
  setGlobalAbuseProtection,
  getGlobalAbuseProtection,
  hasGlobalAbuseProtection,
  clearGlobalAbuseProtection,
  isBudgetEnabled,
  isPowEnabled,
  DEFAULT_POW_DIFFICULTY,
  DEFAULT_POW_TTL_MS,
} from "./abuse/config";
export type {
  AbuseProtectionInput,
  AbuseProtectionConfig,
  BudgetConfig,
  BudgetClassConfig,
  PowConfig,
  PowDifficultyContext,
  EndpointPowConfig,
  ResourcePowConfig,
  ResourceCostConfig,
  AbuseOperation,
  CaptchaConfig,
  CaptchaContext,
  EndpointCaptchaConfig,
  ResourceCaptchaConfig,
  OverflowMechanism,
} from "./abuse/config";
export {
  turnstile,
  hcaptcha,
  recaptcha,
  customCaptcha,
} from "./abuse/captcha";
export type { CaptchaProvider, CaptchaVerifyContext } from "./abuse/captcha";
export { createAbuseMiddleware } from "./abuse/middleware";
export { enforceAbuse } from "./abuse/enforce";
export type { EnforceAbuseOptions, AbuseGateResult } from "./abuse/enforce";
export {
  issueChallenge,
  verifySolution,
  computeFingerprint,
  consumeNonce,
  resolvePowSecret,
} from "./pow/server";
export {
  solveChallenge,
  sha256Hex,
  leadingZeroBits,
} from "./pow/core";
export type { PowAlgorithm, ChallengePayload } from "./pow/core";

// Middleware
export { createRateLimiter } from "./middleware/rateLimit";
export { errorHandler, notFoundHandler } from "./middleware/error";
export { createSecurityHeaders, STRICT_API_CSP } from "./middleware/securityHeaders";
export type {
  SecurityHeadersOptions,
  HSTSOptions,
  FrameOption,
} from "./middleware/securityHeaders";

// Server runtime helpers
export { createSSEStream, formatSSE, formatSSEComment } from "./server/sse";
export type { SSEWriter, SSEStreamOptions, SSEMessage } from "./server/sse";
export { getClientIP, readJsonBody } from "./server/request";
export { requireUser, isAuthenticated as isContextAuthenticated, getSession as getContextSession } from "./server/context";
export { readEnv, isDebugEnabled, isProduction } from "./server/env";
export { beginShutdown, isShuttingDown, onShutdown } from "./server/lifecycle";
export type { ShutdownHook } from "./server/lifecycle";
export { createLogger, getLogger, setLogger, defaultSink } from "./server/logger";
export type {
  Logger,
  LogLevel,
  LogFields,
  LogRecord,
  LogSink,
  CreateLoggerOptions,
} from "./server/logger";
export {
  observabilityMiddleware,
  createMetricsCollector,
} from "./middleware/observability";
export type {
  RequestMetrics,
  SubscriptionMetrics,
  ErrorMetrics,
  MetricsConfig,
  ObservabilityConfig,
  MetricsCollector,
} from "./middleware/observability";

// Admin UI
export {
  createAdminUI,
  createAdminRequestLogger,
  registerResourceSchema,
  unregisterResourceSchema,
  getResourceSchema,
  getAllResourceSchemas,
  getSchemaInfo,
  getAllSchemaInfos,
  getAllResourcesForDisplay,
  setAdminAuditAdapter,
  setRequestLogAdapter,
  setErrorLogAdapter,
} from "./ui";
export type {
  AdminUIConfig,
  SchemaRegistryEntry,
  ColumnInfo,
  SchemaInfo,
  ResourceDisplayInfo,
} from "./ui";

// Observability log adapters (pluggable persistence for audit/request/error/metrics)
export {
  createInMemoryLogAdapter,
  createKVLogAdapter,
} from "./observability";
export type {
  ObservabilityLogAdapter,
  LogAdapterOptions,
  LogQuery,
  LogOrder,
} from "./observability";

// Health Endpoints
export { createHealthEndpoints } from "./health";
export type {
  HealthConfig,
  HealthResponse,
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
} from "./health";

// OpenAPI
export {
  generateOpenAPISpec,
  serveOpenAPI,
  createCovaraRouter,
  extractSchemaInfo,
  buildCovaraSchema,
  generateTypeScriptTypes,
} from "./openapi";
export type {
  OpenAPIConfig,
  RegisteredResource,
  ResourceSchemaInfo,
  FieldSchemaInfo,
  TypeInfo,
  CovaraSchema,
} from "./openapi";

// KV Store
export {
  createKV,
  initializeKV,
  createMemoryKV,
  createRedisKV,
  createRedisKVFromConfig,
  createDurableObjectKV,
  setGlobalKV,
  getGlobalKV,
  hasGlobalKV,
  MemoryKVStore,
  RedisKVStore,
  CovaraKVDurableObject,
  DurableKVEngine,
  DurableObjectKVStore,
} from "./kv";
export type {
  KVAdapter,
  KVTransaction,
  KVConfig,
  RedisConfig,
  DurableObjectConfig,
  DurableObjectKVOptions,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  DurableObjectStateLike,
  DurableObjectStorageLike,
  WebSocketLike,
  SetOptions,
} from "./kv";

// Subscription initialization (for multi-process deployments)
export { initializeEventSubscription, listActiveSubscriptions, disconnectSubscription, getActiveHandlerCount, registerAggregateWatcher, notifyAggregateWatchers, getAggregateWatcherCount } from "./resource/subscription";
export type { ActiveSubscriptionInfo } from "./resource/subscription";

// OIDC Provider
export {
  createOIDCProvider,
  oidcProviders,
  generateDiscoveryDocument,
  createKeyManager,
  createTokenService,
  createEmailPasswordBackend,
  createFederatedBackend,
  createPassportBackend,
} from "./oidc";
export type {
  OIDCProviderConfig,
  OIDCProviderResult,
  OIDCClient,
  OIDCUser,
  OIDCDiscoveryDocument,
  TokenResponse,
  TokenService,
  KeyManager,
  AuthBackend,
  AuthBackendResult,
  AuthBackendsConfig,
  EmailPasswordBackendConfig,
  PassportBackendConfig,
  FederatedProvider,
  IDTokenClaims,
  AccessTokenClaims,
  TokenConfig,
  KeyConfig,
  UIConfig,
  SecurityConfig,
  ProviderHooks,
} from "./oidc";

// Background Tasks
export {
  defineTask,
  initializeTasks,
  getTaskScheduler,
  getTaskRegistry,
  createTaskScheduler,
  createTaskRegistry,
  createTaskWorker,
  startTaskWorkers,
  createTaskTriggerHooks,
  composeHooks as composeTaskHooks,
  createConcurrencyLimiter,
  createIdempotencyStore,
} from "./tasks";
export type {
  ConcurrencyLimiter,
  IdempotencyStore,
  TaskDefinition,
  TaskContext,
  Task,
  TaskStatus,
  TaskFilter,
  ScheduleOptions,
  RecurringConfig,
  RetryConfig,
  WorkerConfig,
  WorkerStats,
  TaskScheduler,
  TaskRegistry,
  TaskWorker,
  TaskWorkerDbConfig,
} from "./tasks";

// Relations
export {
  parseInclude,
  parseNestedFilter,
} from "./resource/relations";
export type {
  RelationType,
  RelationConfig,
  RelationsConfig,
  IncludeSpec,
  IncludeConfig,
} from "./resource/types";

// Environment Variables
export { createEnv, envVariable, usePublicEnv } from "./env";
export type { PublicEnvConfig, PublicEnvSchema, EnvSchemaField } from "./env";

// Search
export {
  setGlobalSearch,
  getGlobalSearch,
  hasGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
  createOpenSearchAdapter,
  createSqliteFtsAdapter,
  createPostgresFtsAdapter,
} from "./search";
export type {
  SearchAdapter,
  SearchQuery,
  SearchHit,
  SearchResult,
  SearchConfig,
  FieldMapping,
  IndexMappings,
  OpenSearchConfig,
  SqliteFtsConfig,
  PostgresFtsConfig,
} from "./search";
export type { ResourceSearchConfig, SearchFieldConfig } from "./resource/types";

// Storage (File Uploads)
export {
  setGlobalStorage,
  getGlobalStorage,
  hasGlobalStorage,
  clearGlobalStorage,
  createStorage,
  initializeStorage,
  createMemoryStorage,
  createLocalStorage,
  createS3Storage,
  MemoryStorageAdapter,
  LocalStorageAdapter,
  S3StorageAdapter,
  createR2Adapter,
  R2BindingAdapter,
  R2S3Adapter,
  validateUpload,
} from "./storage";
export type {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
  LocalStorageConfig,
  S3StorageConfig,
  StorageConfig,
  R2StorageConfig,
  R2S3Config,
  R2BindingConfig,
  R2Bucket,
  UploadValidationOptions,
  UploadValidationInput,
} from "./storage";
export { useFileResource } from "./storage/resource";
export type { FileResourceConfig, FileRecord, FileTableSchema } from "./storage/resource";

// Mutation Tracking
export {
  trackMutations,
  isTrackedDb,
  invalidateCache,
  invalidateAllCache,
  recordExternalMutation,
} from "./resource/track-mutations";
export {
  enqueueSearchOp,
  drainSearchOutbox,
  startSearchOutboxDrainer,
  stopSearchOutboxDrainer,
  getSearchOutboxStats,
} from "./resource/search-outbox";
export type { SearchOutboxOp, SearchOutboxConfig } from "./resource/search-outbox";

// Database lifecycle (framework-owned internal tables, migrations, seeding)
export {
  migrateInternal,
  autoMigrate,
  detectDialect,
  seed,
  createSeed,
  recommendedPoolConfig,
  internalSchema,
  internalSchemaSqlite,
  internalSchemaPg,
  authSessions,
  authAccounts,
  authApiKeys,
  authVerificationTokens,
  INTERNAL_TABLE_NAMES,
  SESSION_KEYS,
  ACCOUNT_KEYS,
  API_KEY_KEYS,
  VERIFICATION_KEYS,
  defineInternalSchema,
  makeIdentityResolver,
} from "./db";
export type {
  Dialect,
  MigrateOptions,
  MigrationSummary,
  SeedOptions,
  SeedSummary,
  PoolDriver,
  PoolConfig,
  InternalTableName,
  SessionKey,
  AccountKey,
  ApiKeyKey,
  VerificationKey,
  TableResolver,
  InternalTableOverride,
  InternalSchemaInput,
  InternalSchemaBundle,
} from "./db";

// Email
export {
  setGlobalEmail,
  getGlobalEmail,
  hasGlobalEmail,
  clearGlobalEmail,
  sendEmail,
  sendEmailBatch,
  createEmail,
  EmailBuilder,
  createResendAdapter,
  createCloudflareEmailAdapter,
  buildMimeMessage,
} from "./email";
export type {
  EmailAdapter,
  EmailMessage,
  EmailAddress,
  EmailAttachment,
  SendEmailResult,
  EmailTheme,
  BuiltEmail,
} from "./email";

// Billing
export {
  setGlobalBilling,
  getGlobalBilling,
  hasGlobalBilling,
  clearGlobalBilling,
  createBilling,
  createCreditsLedger,
  createBillingRouter,
  createStripeAdapter,
  createLemonSqueezyAdapter,
  createPaddleAdapter,
  createPolarAdapter,
  BillingError,
} from "./billing";
export type {
  Billing,
  BillingConfig,
  BillingPlan,
  BillingAdapter,
  BillingProviderName,
  BillingCustomer,
  BillingSubscription,
  SubscriptionStatus,
  CheckoutSession,
  CreateCheckoutInput,
  BillingEvent,
  BillingEventType,
  CreditsLedger,
  CreditEntry,
  BillingRouterOptions,
} from "./billing";
export type {
  TableRegistration,
  TrackMutationsConfig,
  CacheConfig,
  TrackedDatabase,
} from "./resource/track-mutations";
