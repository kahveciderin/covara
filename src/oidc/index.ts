export { createOIDCProvider } from "./provider";
export type { OIDCProviderResult } from "./provider";

export { generateDiscoveryDocument } from "./discovery";
export { createKeyManager } from "./keys";
export { createTokenService, validateIdTokenNonce } from "./tokens";
export { redirectUriMatches, redirectUriAllowed, escapeHtml, algorithmToHash } from "./util";
export { createOIDCRateLimiter, resetOIDCRateLimits } from "./rate-limit";
export {
  createStores,
  InMemoryClientStore,
  InMemoryAuthorizationCodeStore,
  InMemoryRefreshTokenStore,
  InMemoryConsentStore,
  InMemoryInteractionStore,
  InMemoryStateStore,
  KVClientStore,
  KVAuthorizationCodeStore,
  KVRefreshTokenStore,
  KVConsentStore,
  KVInteractionStore,
  KVStateStore,
} from "./stores";

export { createEmailPasswordBackend, createFederatedBackend } from "./backends";
export { clearFederatedCaches } from "./backends/federated";

export {
  createAuthorizeEndpoint,
  createTokenEndpoint,
  createUserInfoEndpoint,
  createJWKSEndpoint,
  createLogoutEndpoint,
} from "./endpoints";

export { createLoginHandler, createConsentHandler } from "./ui";

export type {
  OIDCProviderConfig,
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
  PassportBackendConfig,
  AuthJsBackendConfig,
  IDTokenClaims,
  AccessTokenClaims,
  AuthorizationRequest,
  AuthorizationCode,
  RefreshTokenData,
  TokenRequest,
  UserConsent,
  InteractionData,
  JWK,
  KeyConfig,
  TokenConfig,
  StoreConfig,
  UIConfig,
  SecurityConfig,
  RegistrationConfig,
  ProviderHooks,
  ScopeDefinition,
  ClaimDefinition,
  ClientStore,
  AuthorizationCodeStore,
  RefreshTokenStore,
  ConsentStore,
  InteractionStore,
  StateStore,
  OIDCProviderStores,
  Algorithm,
  GrantType,
  ResponseType,
  TokenAuthMethod,
  PKCEMethod,
} from "./types";

export const oidcProviders = {
  google: (config: { clientId: string; clientSecret: string }) => ({
    name: "google",
    issuer: "https://accounts.google.com",
    ...config,
  }),
  microsoft: (config: { clientId: string; clientSecret: string; tenantId?: string }) => ({
    name: "microsoft",
    issuer: `https://login.microsoftonline.com/${config.tenantId ?? "common"}/v2.0`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }),
  okta: (config: { clientId: string; clientSecret: string; domain: string }) => ({
    name: "okta",
    issuer: `https://${config.domain}`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }),
  auth0: (config: { clientId: string; clientSecret: string; domain: string }) => ({
    name: "auth0",
    issuer: `https://${config.domain}`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }),
  keycloak: (config: {
    clientId: string;
    clientSecret: string;
    realm: string;
    baseUrl: string;
  }) => ({
    name: "keycloak",
    issuer: `${config.baseUrl}/realms/${config.realm}`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }),
  generic: (config: {
    name: string;
    clientId: string;
    clientSecret: string;
    issuer: string;
    scopes?: string[];
  }) => config,
};
