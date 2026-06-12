import { ClientConfig, ResourceClient, OfflineConfig, CovaraClient, CheckAuthResult, ProcedureDef, AnyProcedures } from "./types";
import { createTransport } from "./transport";
import { createRepository } from "./repository";
import { createOfflineManager, OfflineManager, LocalStorageOfflineStorage } from "./offline";
import { setGlobalClient, setAuthErrorHandler, getAuthErrorHandler } from "./globals";
import { LiveQueryCache, InvalidateTarget } from "./query-cache";
import type { LiveQueryOptions } from "./live-store";
import type { LiveListResourceClient, LiveQueryOptionsLike } from "./types";
import {
  createAuthManager,
  OIDCClientConfig,
} from "./auth";
import { createJWTClient, JWTClient, JWTClientConfig } from "./jwt";
import type { DateFieldRegistry } from "./dates";
import { createBillingClient } from "./billing";

export { getClient, setGlobalClient, getAuthErrorHandler } from "./globals";
export type { CovaraClient } from "./types";

export interface SimplifiedClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  offline?: boolean | OfflineConfig;
  onError?: (error: Error) => void;
  onSyncComplete?: () => void;
  authCheckUrl?: string;
  auth?: OIDCClientConfig;
  jwt?: Omit<JWTClientConfig, "baseUrl">;
  /** Opt into automatic ISO date-string -> Date conversion (see TransportConfig.parseDates). */
  parseDates?: boolean | DateFieldRegistry;
  /** Configure the typed billing client (mounted server-side, default `/api/billing`). */
  billing?: { basePath?: string };
}

export const createClient = (config: SimplifiedClientConfig): CovaraClient => {
  const auth = createAuthManager();
  let jwtClient: JWTClient | undefined;

  const transport = createTransport({
    baseUrl: config.baseUrl,
    headers: config.headers,
    credentials: config.credentials,
    timeout: config.timeout,
    parseDates: config.parseDates,
    refreshAuth: async () => {
      if (jwtClient?.isAuthenticated()) {
        const tokens = await jwtClient.refresh();
        return tokens.accessToken;
      }
      if (config.auth) {
        const tokens = await auth.refreshTokens();
        return tokens.accessToken;
      }
    },
  });

  if (config.jwt) {
    jwtClient = createJWTClient({
      ...config.jwt,
      baseUrl: config.baseUrl,
      onAuthChange: (authenticated) => {
        if (authenticated) {
          const token = jwtClient!.getAccessToken();
          if (token) {
            transport.setHeader("Authorization", `Bearer ${token}`);
          }
        } else {
          transport.removeHeader("Authorization");
        }
      },
    });

    // Set initial token if exists
    const initialToken = jwtClient.getAccessToken();
    if (initialToken) {
      transport.setHeader("Authorization", `Bearer ${initialToken}`);
    }

    // Subscribe to state changes for token updates
    jwtClient.subscribe((state) => {
      if (state.accessToken) {
        transport.setHeader("Authorization", `Bearer ${state.accessToken}`);
      } else {
        transport.removeHeader("Authorization");
      }
    });
  }

  if (config.auth) {
    auth.configure(config.auth);
    auth.subscribe((state) => {
      if (state.accessToken) {
        transport.setHeader("Authorization", `Bearer ${state.accessToken}`);
      } else {
        transport.removeHeader("Authorization");
      }
    });
  }

  let offline: OfflineManager | undefined;

  const offlineConfig: OfflineConfig | undefined =
    config.offline === true
      ? { enabled: true, storage: new LocalStorageOfflineStorage("covara-mutations") }
      : config.offline === false
        ? undefined
        : config.offline;

  if (offlineConfig?.enabled) {
    offline = createOfflineManager({
      config: offlineConfig,
      onMutationSync: async (mutation) => {
        let response: { data: Record<string, unknown> };
        switch (mutation.type) {
          case "create":
            response = await transport.request({
              method: "POST",
              path: mutation.resource,
              body: mutation.data,
              headers: mutation.optimisticId ? {
                "X-Covara-Optimistic-Id": mutation.optimisticId,
                "X-Idempotency-Key": mutation.idempotencyKey,
              } : undefined,
            });
            return {
              success: true,
              serverId: (response.data as { id?: string }).id,
            };
          case "update": {
            const resolvedId = offline!.resolveId(mutation.objectId!);
            response = await transport.request({
              method: "PATCH",
              path: `${mutation.resource}/${resolvedId}`,
              body: mutation.data,
            });
            return { success: true };
          }
          case "delete": {
            const resolvedId = offline!.resolveId(mutation.objectId!);
            await transport.request({
              method: "DELETE",
              path: `${mutation.resource}/${resolvedId}`,
            });
            return { success: true };
          }
          default:
            return { success: true };
        }
      },
      onMutationFailed: (mutation, error) => {
        console.error("Mutation failed:", mutation, error);
        config.onError?.(error);
      },
      onSyncComplete: config.onSyncComplete,
      onIdRemapped: offlineConfig.onIdRemapped,
    });
  }

  const resolveRepo = <T extends { id: string }>(path: string): LiveListResourceClient<T> =>
    createRepository<T>({ transport, resourcePath: path, offline });

  const queryCache = new LiveQueryCache({
    resolveRepo,
    callbacks: {
      onAuthError: () => getAuthErrorHandler()?.(),
      getPendingCount: offline
        ? async () => (await offline!.getPendingMutations())?.length ?? 0
        : undefined,
      onIdRemapped: offline ? (o, s) => offline!.registerIdMapping(o, s) : undefined,
      getIdMappings: offline ? () => offline!.getIdMappings() : undefined,
      hasPendingMutationsForId: offline
        ? (id) => offline!.hasPendingMutationsForId(id)
        : undefined,
    },
  });

  // Cross-tab invalidation: when another tab broadcasts invalidate, mirror it locally.
  offline?.onTabMessage((message) => {
    if (message.kind === "invalidate") {
      for (const path of message.paths) queryCache.invalidate(path);
    } else if (message.kind === "sync-complete") {
      // A leader tab finished flushing; refresh everything so this tab catches up.
      queryCache.invalidate(() => true);
    }
  });

  const client: CovaraClient = {
    transport,
    offline,
    auth,
    jwt: jwtClient,
    billing: createBillingClient({ transport, basePath: config.billing?.basePath }),
    queryCache,

    resource<T extends { id: string }, P extends Record<keyof P, ProcedureDef> = AnyProcedures>(
      path: string
    ): ResourceClient<T, P> {
      return createRepository<T, P>({
        transport,
        resourcePath: path,
        offline,
      });
    },

    invalidate(target: InvalidateTarget): number {
      const count = queryCache.invalidate(target);
      if (typeof target === "string") {
        offline?.broadcastInvalidate([target]);
      }
      return count;
    },

    async prefetch(
      resource: string,
      options: LiveQueryOptionsLike = {}
    ): Promise<void> {
      await queryCache.prefetch(resource, options as LiveQueryOptions);
    },

    setAuthToken(token: string): void {
      transport.setHeader("Authorization", `Bearer ${token}`);
    },

    clearAuthToken(): void {
      transport.removeHeader("Authorization");
    },

    setAuthErrorHandler(handler: () => void): void {
      setAuthErrorHandler(handler);
    },

    async getPendingCount(): Promise<number> {
      if (!offline) return 0;
      const mutations = await offline.getPendingMutations();
      return mutations?.length ?? 0;
    },

    async checkAuth<TUser = unknown>(url?: string): Promise<CheckAuthResult<TUser>> {
      if (auth.isAuthenticated()) {
        const user = auth.getUser();
        return { user: user as TUser | null };
      }

      if (jwtClient?.isAuthenticated()) {
        const user = await jwtClient.getUser();
        if (user) {
          return { user: user as unknown as TUser };
        }
      }

      const authUrl = url ?? config.authCheckUrl ?? "/api/auth/me";
      try {
        const headers: Record<string, string> = {};

        const jwtToken = jwtClient?.getAccessToken();
        if (jwtToken) {
          headers["Authorization"] = `Bearer ${jwtToken}`;
        }

        const response = await fetch(`${config.baseUrl}${authUrl}`, {
          credentials: config.credentials ?? "include",
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        });
        const data = (await response.json()) as { user?: TUser | null; expiresAt?: string };
        return {
          user: data.user ?? null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        };
      } catch {
        return { user: null };
      }
    },
  };

  // Set as global client (HMR-safe)
  setGlobalClient(client);

  return client;
};

// HMR-safe client getter
export const getOrCreateClient = (config: SimplifiedClientConfig): CovaraClient => {
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__covaraClient) {
    return (globalThis as Record<string, unknown>).__covaraClient as CovaraClient;
  }
  return createClient(config);
};

// Legacy config support
export const createClientLegacy = (config: ClientConfig): CovaraClient => {
  return createClient({
    baseUrl: config.baseUrl,
    headers: config.headers,
    credentials: config.credentials,
    timeout: config.timeout,
    offline: config.offline,
    onError: config.onError,
    onSyncComplete: config.onSyncComplete,
  });
};

export * from "./types";

export type { Transport } from "./transport";
export {
  FetchTransport,
  TransportError,
  createTransport,
} from "./transport";

export {
  Repository,
  createRepository,
} from "./repository";

export {
  ResourceQueryBuilder,
  createResourceQueryBuilder,
} from "./resource-query-builder";

export type {
  NumericKeys,
  StringKeys,
  ComparableKeys,
  DateKeys,
  BooleanKeys,
  TypedAggregationGroup,
  TypedAggregationResponse,
  TypedPaginatedResponse,
  QueryBuilderState,
} from "./query-types";

export {
  OfflineManager,
  InMemoryOfflineStorage,
  LocalStorageOfflineStorage,
  IndexedDBOfflineStorage,
  isIndexedDBAvailable,
  createOfflineStorage,
  createOfflineManager,
  mergeConflict,
} from "./offline";

export {
  createTabSync,
  isTabSyncSupported,
} from "./tab-sync";
export type { TabSync, TabSyncMessage } from "./tab-sync";

export {
  LiveQueryCache,
} from "./query-cache";
export type {
  CachedQueryEntry,
  InvalidateTarget,
  InvalidatePredicate,
} from "./query-cache";

export {
  createMutation,
  resourceMutationFn,
} from "./mutation";
export type {
  MutationStatus,
  MutationState,
  MutationController,
  MutationOptions,
  MutationFn,
  MutationFnContext,
  CreateMutationConfig,
  ResourceMutationVars,
  ResourceMutationKind,
} from "./mutation";

export {
  SubscriptionManager,
  createSubscription,
  computeBackoffDelay,
} from "./subscription-manager";

export {
  AggregateSubscriptionManager,
  createAggregateSubscription,
  buildAggregateParams,
} from "./aggregate-subscription";
export type { AggregateSubscriptionConfig } from "./aggregate-subscription";

export {
  fetchSchema,
  generateTypes,
  createTypegenCLI,
} from "./typegen";
export type { TypegenOptions, TypegenResult } from "./typegen";

export {
  createLiveQuery,
  statusLabel,
} from "./live-store";
export type {
  LiveQuery,
  LiveQueryStatus,
  LiveQueryState,
  LiveQueryOptions,
  LiveQueryMutations,
} from "./live-store";

export {
  AuthManager,
  createAuthManager,
  OIDCClient,
  createOIDCClient,
  TokenManager,
  MemoryStorage,
  LocalStorageAdapter,
  SessionStorageAdapter,
  createTokenManager,
  AuthTransport,
  createAuthTransport,
} from "./auth";
export type {
  OIDCClientConfig,
  TokenSet,
  OIDCUserInfo,
  AuthState,
  AuthStatus,
  TokenStorage,
  OIDCDiscoveryResponse,
  TokenResponse as OIDCTokenResponse,
  PKCEChallenge,
  AuthCallbackParams,
  AuthManagerEvents,
} from "./auth";

export {
  q,
  createQueryBuilder,
  where,
  createTypedQueryBuilder,
  createFieldBuilder,
  createTypedFilter,
  f,
  include,
  withSelect,
  withLimit,
  withOptions,
  createIncludeBuilder,
  IncludeBuilder,
  QueryBuilderChain,
} from "./query-builder";
export type {
  QueryBuilder,
  Primitive,
  FieldBuilder,
  TypedQueryBuilder,
  TypedFilter,
  IncludeOptions,
  IncludeConfig,
} from "./query-builder";

export {
  toDate,
  toDateOrNull,
  isISODateString,
  reviveDates,
} from "./dates";
export type {
  ISODateString,
  DateFieldRegistry,
} from "./dates";

export {
  createEnvClient,
  fetchPublicEnv,
  fetchEnvSchema,
  generateEnvTypeScript,
} from "./env";
export type {
  EnvClient,
  EnvClientConfig,
  EnvSchemaField,
  PublicEnvSchema,
} from "./env";

export {
  createFileClient,
} from "./file-upload";
export type {
  FileClient,
  FileUploadOptions,
  UploadProgress,
  UploadedFile,
  PresignedUploadResponse,
  FileListOptions,
  FileListResponse,
  FileClientConfig,
} from "./file-upload";

export {
  createBillingClient,
  isActiveSubscription,
} from "./billing";
export type {
  BillingClient,
  BillingClientConfig,
  BillingSubscription,
  SubscriptionStatus,
  BillingProviderName,
  CheckoutInput,
  CheckoutItem,
  CheckoutMode,
  CheckoutResult,
  PortalResult,
} from "./billing";

export {
  createJWTClient,
  MemoryTokenStorage as JWTMemoryTokenStorage,
  LocalStorageTokenStorage as JWTLocalStorageTokenStorage,
} from "./jwt";
export type {
  JWTClient,
  JWTClientConfig,
  JWTTokens,
  JWTUser,
  JWTAuthState,
  TokenStorage as JWTTokenStorage,
} from "./jwt";
