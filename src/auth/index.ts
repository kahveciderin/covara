export * from "./types";
export * from "./adapter";
export * from "./password";
export * from "./rsql";
export * from "./scope";
export * from "./middleware";
export * from "./routes";
export {
  createCsrfMiddleware,
  issueCsrfToken,
  generateCsrfToken,
  type CsrfOptions,
} from "./csrf";
export {
  LoginThrottle,
  type LoginThrottleOptions,
  type ThrottleCheck,
} from "./login-throttle";
export {
  InMemoryVerificationTokenStore,
  KVVerificationTokenStore,
  createKVVerificationTokenStore,
  issueToken,
  verifyToken,
  hashToken,
  generateToken,
  type VerificationTokenStore,
  type VerificationTokenRecord,
} from "./verification";
export {
  issuePasswordResetToken,
  verifyPasswordResetToken,
  hashNewPassword,
  type PasswordResetOptions,
} from "./password-reset";
export {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  getTotpUri,
  generateBackupCodes,
  verifyBackupCode,
  type TotpOptions,
  type TotpUriParams,
  type BackupCodesResult,
} from "./totp";
export {
  issueMagicLinkToken,
  consumeMagicLinkToken,
  type MagicLinkOptions,
} from "./magic-link";
export {
  createApiKey,
  verifyApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  InMemoryApiKeyStore,
  KVApiKeyStore,
  createKVApiKeyStore,
  type ApiKeyStore,
  type StoredApiKey,
  type ApiKeyMetadata,
  type CreatedApiKey,
  type CreateApiKeyOptions,
  type RotateApiKeyOptions,
  type VerifyApiKeyResult,
} from "./api-keys";
export {
  validatePasswordStrength,
  enforcePasswordStrength,
  builtInPasswordDenylist,
  type PasswordPolicyOptions,
  type PasswordStrengthResult,
} from "./password-policy";
export {
  createAuthAdapter,
  createSessionStore,
  type AuthMode,
  type AuthConfig,
  type AuthConfigUser,
  type SessionStoreConfig,
} from "./config";

export { AuthJsAdapter, createAuthJsAdapter } from "./adapters/authjs";
export { PassportAdapter, createPassportAdapter, fromPassportUser } from "./adapters/passport";
export { JWTAdapter, createJWTAdapter } from "./adapters/jwt";
export type { JWTConfig, JWTAdapterOptions, JWTPayload, JWTUser } from "./adapters/jwt";
export { OIDCAdapter, createOIDCAdapter, oidcProviders } from "./adapters/oidc";
export type {
  OIDCProviderConfig,
  OIDCAdapterOptions,
  OIDCUserInfo,
  OIDCAccount,
  OIDCUser,
} from "./adapters/oidc";

export {
  KVSessionStore,
  createKVSessionStore,
  RedisSessionStore,
  createRedisSessionStore,
  DrizzleSessionStore,
  createDrizzleSessionStore,
} from "./stores";
export type {
  KVSessionStoreOptions,
  RedisSessionStoreOptions,
  DrizzleSessionStoreOptions,
  SessionsTableColumns,
} from "./stores";
