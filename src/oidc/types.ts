import type { Context, Hono } from "hono";
import { SessionStore } from "@/auth/types";
import { KVAdapter } from "@/kv/types";
import type { SocialProvider, SocialAccount } from "@/auth/passport-bridge";
import type { SocialStateStore } from "@/auth/social";

export type GrantType =
  | "authorization_code"
  | "refresh_token"
  | "client_credentials";

export type ResponseType =
  | "code"
  | "token"
  | "id_token"
  | "code id_token"
  | "code token"
  | "id_token token"
  | "code id_token token";

export type TokenAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

export type PKCEMethod = "S256" | "plain";

export interface OIDCClient {
  id: string;
  secret?: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  grantTypes: GrantType[];
  responseTypes: ResponseType[];
  tokenEndpointAuthMethod: TokenAuthMethod;
  scopes: string[];
  audiences?: string[];
  metadata?: Record<string, unknown>;
}

export interface OIDCUser {
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

export interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  at_hash?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  [key: string]: unknown;
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  jti: string;
  scope: string;
  client_id: string;
  [key: string]: unknown;
}

export interface AuthorizationRequest {
  responseType: ResponseType;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: PKCEMethod;
  prompt?: "none" | "login" | "consent" | "select_account";
  maxAge?: number;
  loginHint?: string;
  acrValues?: string;
  returnTo?: string;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: PKCEMethod;
  authTime: number;
  expiresAt: number;
}

export interface RefreshTokenData {
  token: string;
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  createdAt: number;
}

export interface TokenRequest {
  grantType: GrantType;
  code?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  codeVerifier?: string;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface UserConsent {
  userId: string;
  clientId: string;
  scopes: string[];
  grantedAt: number;
  expiresAt?: number;
}

export interface InteractionData {
  authRequest: AuthorizationRequest;
  userId?: string;
  expiresAt: number;
}

export interface OIDCDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  claims_supported: string[];
  code_challenge_methods_supported: string[];
  claims_parameter_supported: boolean;
  request_parameter_supported: boolean;
  request_uri_parameter_supported: boolean;
}

export interface JWK {
  kty: "RSA" | "EC";
  use: "sig";
  alg: string;
  kid: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

export interface JWKPrivate extends JWK {
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  kid: string;
  alg: string;
}

export type Algorithm = "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "ES512" | "PS256" | "PS384" | "PS512";

export interface KeyConfig {
  algorithm?: Algorithm;
  privateKey?: string | Buffer;
  publicKey?: string | Buffer;
  keyId?: string;
  rotationIntervalMs?: number;
}

export interface TokenConfig {
  accessToken?: {
    ttlSeconds?: number;
    format?: "jwt" | "opaque";
  };
  idToken?: {
    ttlSeconds?: number;
  };
  refreshToken?: {
    enabled?: boolean;
    ttlSeconds?: number;
    rotateOnUse?: boolean;
  };
  authorizationCode?: {
    ttlSeconds?: number;
  };
}

export interface EmailPasswordBackendConfig {
  enabled: boolean;
  validateUser: (email: string, password: string) => Promise<OIDCUser | null>;
  findUserById: (id: string) => Promise<OIDCUser | null>;
  createUser?: (data: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<OIDCUser>;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

export interface PassportBackendConfig {
  // Any Passport.js OAuth2 strategies, wrapped with `fromPassport(...)`. Each
  // becomes a federated login button on the provider's login page.
  providers: SocialProvider[];
  // Resolve an existing local user for a verified provider account.
  findUserByAccount?: (
    provider: string,
    providerAccountId: string
  ) => Promise<OIDCUser | null>;
  // Resolve a user by id — needed so consent / token / userinfo can look the
  // user up after login when no email/password backend is configured.
  findUserById?: (id: string) => Promise<OIDCUser | null>;
  // Create (or upsert) the local user for a first-time provider account.
  createUser: (account: SocialAccount) => Promise<OIDCUser>;
  // Optional: persist the provider↔user link after creation.
  linkAccount?: (
    userId: string,
    provider: string,
    providerAccountId: string
  ) => Promise<void>;
  // Shared store for the redirect→callback handshake (default: KV when a global
  // KV is configured, else in-memory). Use a shared store on Workers / multi-instance.
  stateStore?: SocialStateStore;
}

export interface AuthJsBackendConfig {
  db: unknown;
  tables: {
    users: unknown;
    sessions: unknown;
    accounts?: unknown;
  };
}

export interface FederatedProvider {
  name: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  scopes?: string[];
  mapUser?: (claims: Record<string, unknown>) => Promise<OIDCUser>;
}

export interface AuthBackendsConfig {
  emailPassword?: EmailPasswordBackendConfig;
  passport?: PassportBackendConfig;
  authjs?: AuthJsBackendConfig;
  federated?: FederatedProvider[];
}

export interface StoreConfig {
  type: "memory" | "redis" | "drizzle";
  kv?: KVAdapter;
  sessionStore?: SessionStore;
  prefix?: string;
  db?: unknown;
  tables?: Record<string, unknown>;
}

export interface UIConfig {
  loginPath?: string;
  consentPath?: string;
  templates?: {
    login?: string;
    consent?: string;
    loggedOut?: string;
    error?: string;
  };
  customLoginHandler?: (
    c: Context,
    interaction: InteractionData
  ) => Promise<Response>;
  customConsentHandler?: (
    c: Context,
    interaction: InteractionData,
    client: OIDCClient,
    user: OIDCUser
  ) => Promise<Response>;
}

export interface SecurityConfig {
  pkce?: {
    required?: boolean;
    methods?: PKCEMethod[];
  };
  nonce?: {
    required?: boolean;
  };
  consent?: {
    ttlSeconds?: number;
  };
  allowedOrigins?: string[];
  trustedProxies?: string[];
  rateLimiting?: {
    login?: { windowMs: number; max: number };
    token?: { windowMs: number; max: number };
    jwks?: { windowMs: number; max: number };
    introspect?: { windowMs: number; max: number };
  };
}

export interface RegistrationConfig {
  enabled?: boolean;
  defaultScopes?: string[];
  initialAccessToken?: string;
}

export interface ProviderHooks {
  onUserAuthenticated?: (user: OIDCUser, method: string) => Promise<void>;
  onTokenIssued?: (
    userId: string,
    clientId: string,
    scopes: string[]
  ) => Promise<void>;
  onConsentGranted?: (
    userId: string,
    clientId: string,
    scopes: string[]
  ) => Promise<void>;
  onLogout?: (userId: string, sessionId?: string) => Promise<void>;
  getUserInfoClaims?: (
    user: OIDCUser,
    scopes: string[]
  ) => Promise<Record<string, unknown>>;
  getAccessTokenClaims?: (
    user: OIDCUser,
    client: OIDCClient,
    scopes: string[]
  ) => Promise<Record<string, unknown>>;
}

export interface OIDCProviderConfig {
  issuer: string;
  baseUrl?: string;
  keys: KeyConfig;
  tokens?: TokenConfig;
  clients: OIDCClient[] | ClientStore;
  backends: AuthBackendsConfig;
  stores?: StoreConfig;
  scopes?: ScopeDefinition[];
  claims?: ClaimDefinition[];
  ui?: UIConfig;
  security?: SecurityConfig;
  registration?: RegistrationConfig;
  hooks?: ProviderHooks;
}

export const DEFAULT_CONSENT_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface ScopeDefinition {
  name: string;
  description: string;
  claims?: string[];
}

export interface ClaimDefinition {
  name: string;
  scope: string;
  getValue: (user: OIDCUser) => unknown;
}

export interface ClientStore {
  get(clientId: string): Promise<OIDCClient | null>;
  getAll(): Promise<OIDCClient[]>;
  set(client: OIDCClient): Promise<void>;
  delete(clientId: string): Promise<void>;
}

export interface AuthorizationCodeStore {
  set(code: AuthorizationCode): Promise<void>;
  get(code: string): Promise<AuthorizationCode | null>;
  delete(code: string): Promise<void>;
}

export interface RefreshTokenStore {
  set(data: RefreshTokenData): Promise<void>;
  get(token: string): Promise<RefreshTokenData | null>;
  delete(token: string): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}

export interface ConsentStore {
  get(userId: string, clientId: string): Promise<UserConsent | null>;
  set(consent: UserConsent): Promise<void>;
  delete(userId: string, clientId: string): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}

export interface InteractionStore {
  set(id: string, data: InteractionData): Promise<void>;
  get(id: string): Promise<InteractionData | null>;
  delete(id: string): Promise<void>;
}

export interface StateStore {
  set(
    state: string,
    data: {
      provider: string;
      nonce: string;
      codeVerifier: string;
      returnTo?: string;
    }
  ): Promise<void>;
  get(state: string): Promise<{
    provider: string;
    nonce: string;
    codeVerifier: string;
    returnTo?: string;
  } | null>;
  delete(state: string): Promise<void>;
}

export interface AuthBackend {
  name: string;
  authenticate(c: Context): Promise<AuthBackendResult>;
  getLoginForm?(): {
    fields: Array<{
      name: string;
      type: string;
      label: string;
      required?: boolean;
    }>;
  };
  getExternalProviders?(): Array<{
    name: string;
    authUrl: string;
    icon?: string;
  }>;
  initiateExternalAuth?(providerName: string, c: Context): Promise<Response>;
  handleExternalCallback?(c: Context): Promise<AuthBackendResult>;
  supportsSignup?: boolean;
  createUser?(data: {
    email: string;
    password: string;
    name?: string;
  }): Promise<OIDCUser>;
  getRoutes?(): Hono;
}

export interface AuthBackendResult {
  success: boolean;
  user?: OIDCUser;
  error?: string;
  authTime?: number;
  amr?: string[];
  provider?: string;
  // The pending OIDC interaction this external login should resume, carried
  // through the provider's state from `initiateExternalAuth`.
  interactionId?: string;
}

export interface KeyManager {
  getCurrentKey(): Promise<KeyPair>;
  getPublicKeys(): Promise<JWK[]>;
  signToken(payload: Record<string, unknown>): Promise<string>;
  verifyToken(token: string): Promise<Record<string, unknown>>;
  rotateKeys(): Promise<void>;
  getKeyId(): string;
  getAlgorithm(): Algorithm;
}

export interface TokenService {
  generateTokenSet(params: {
    user: OIDCUser;
    client: OIDCClient;
    scope: string;
    nonce?: string;
    authTime?: number;
    includeIdToken?: boolean;
    includeRefreshToken?: boolean;
  }): Promise<TokenResponse>;
  validateAccessToken(
    token: string
  ): Promise<{ valid: boolean; claims?: AccessTokenClaims }>;
  decodeIdToken(token: string): Promise<IDTokenClaims>;
  revokeRefreshToken(token: string): Promise<void>;
}

export interface OIDCProviderStores {
  clients: ClientStore;
  authorizationCodes: AuthorizationCodeStore;
  refreshTokens: RefreshTokenStore;
  consent: ConsentStore;
  interactions: InteractionStore;
  state: StateStore;
}
