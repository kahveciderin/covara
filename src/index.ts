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

// Middleware
export { createRateLimiter } from "./middleware/rateLimit";
export { errorHandler, notFoundHandler } from "./middleware/error";
export { createSecurityHeaders } from "./middleware/securityHeaders";
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
  registerResourceSchema,
  unregisterResourceSchema,
  getResourceSchema,
  getAllResourceSchemas,
  getSchemaInfo,
  getAllSchemaInfos,
  getAllResourcesForDisplay,
} from "./ui";
export type {
  AdminUIConfig,
  SchemaRegistryEntry,
  ColumnInfo,
  SchemaInfo,
  ResourceDisplayInfo,
} from "./ui";

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
export { initializeEventSubscription } from "./resource/subscription";

// OIDC Provider
export {
  createOIDCProvider,
  oidcProviders,
  generateDiscoveryDocument,
  createKeyManager,
  createTokenService,
  createEmailPasswordBackend,
  createFederatedBackend,
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
