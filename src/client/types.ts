import type { ResourceQueryBuilder } from "./resource-query-builder";
import type { Transport } from "./transport";
import type { OfflineManager } from "./offline";
import type { AuthManager } from "./auth";
import type { JWTClient } from "./jwt";
import type { DateFieldRegistry } from "./dates";
import type { LiveQueryCache, InvalidateTarget } from "./query-cache";
import type { BillingClient } from "./billing";

export type EventType = "added" | "existing" | "changed" | "removed" | "invalidate";

export interface BaseEvent {
  id: string;
  subscriptionId: string;
  seq: number;
  timestamp: number;
}

export interface EventMeta {
  optimisticId?: string;
}

export interface AddedEvent<T = unknown> extends BaseEvent {
  type: "added";
  object: T;
  meta?: EventMeta;
}

export interface ExistingEvent<T = unknown> extends BaseEvent {
  type: "existing";
  object: T;
}

export interface ChangedEvent<T = unknown> extends BaseEvent {
  type: "changed";
  object: T;
  previousObjectId?: string;
}

export interface RemovedEvent extends BaseEvent {
  type: "removed";
  objectId: string;
}

export interface InvalidateEvent extends BaseEvent {
  type: "invalidate";
  reason?: string;
}

export type SubscriptionEvent<T = unknown> =
  | AddedEvent<T>
  | ExistingEvent<T>
  | ChangedEvent<T>
  | RemovedEvent
  | InvalidateEvent;

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface CountResponse {
  count: number;
}

export interface AggregationGroup {
  key: Record<string, unknown> | null;
  count?: number;
  sum?: Record<string, number>;
  avg?: Record<string, number>;
  min?: Record<string, number | string>;
  max?: Record<string, number | string>;
}

export interface AggregationResponse {
  groups: AggregationGroup[];
}

export interface SearchOptions {
  filter?: string;
  limit?: number;
  offset?: number;
  highlight?: boolean;
}

export interface SearchResponse<T> {
  items: T[];
  total: number;
  highlights?: Record<string, Record<string, string[]>>;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ProcedureResponse<T = unknown> {
  data: T;
}

export interface ListOptions {
  filter?: string;
  select?: string[];
  include?: string;
  cursor?: string;
  limit?: number;
  orderBy?: string;
  totalCount?: boolean;
}

export interface GetOptions {
  select?: string[];
  include?: string;
}

export interface AggregateOptions {
  filter?: string;
  groupBy?: string[];
  count?: boolean;
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

export interface SubscribeOptions {
  filter?: string;
  include?: string;
  resumeFrom?: number;
  skipExisting?: boolean;
  knownIds?: string[];
}

export interface AggregateSubscriptionState {
  data: AggregationResponse | null;
  isConnected: boolean;
  error: Error | null;
  lastSeq: number;
}

export interface AggregateSubscriptionCallbacks {
  onData?: (data: AggregationResponse, seq: number) => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export interface AggregateSubscription {
  readonly state: AggregateSubscriptionState;
  unsubscribe(): void;
  reconnect(): void;
}

export interface CreateOptions {
  optimistic?: boolean;
  optimisticId?: string;
}

export interface UpdateOptions {
  optimistic?: boolean;
}

export interface DeleteOptions {
  optimistic?: boolean;
}

export interface BatchCreateOptions<T = unknown> {
  items: T[];
}

export interface BatchUpdateOptions<T = unknown> {
  filter: string;
  data: Partial<T>;
}

export interface BatchDeleteOptions {
  filter: string;
}

export interface SubscriptionState<T> {
  items: Map<string, T>;
  isConnected: boolean;
  lastSeq: number;
  error: Error | null;
}

export interface SubscriptionCallbacks<T> {
  onAdded?: (item: T, meta?: EventMeta) => void;
  onExisting?: (item: T) => void;
  onChanged?: (item: T, previousId?: string) => void;
  onRemoved?: (id: string) => void;
  onInvalidate?: (reason?: string) => void;
  onError?: (error: Error) => void;
  onConnected?: (seq: number) => void;
  onDisconnected?: () => void;
}

export interface TransportConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  refreshAuth?: () => Promise<string | void>;
  /**
   * Opt into automatic ISO date-string -> Date conversion on parsed responses.
   * - `true`: convert every string that looks like an ISO 8601 date.
   * - a registry: convert only the listed field names per resource path. The
   *   `request` call may also pass `dateFields` to scope conversion further.
   * Defaults to off (wire types remain ISO `string`).
   */
  parseDates?: boolean | DateFieldRegistry;
}

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, string | number | boolean | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * When date parsing is enabled on the transport, restrict ISO-string -> Date
   * conversion to these field names for this request.
   */
  dateFields?: readonly string[];
}

export interface TransportResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

export type ConflictResolutionStrategy = "server-wins" | "client-wins" | "merge" | "manual";

export interface ConflictError {
  code: "CONFLICT";
  serverState: unknown;
  clientState: unknown;
  /**
   * Optional snapshot of the object as it was when the client started editing it.
   * When present, the `merge` strategy uses it to detect which fields the client
   * actually changed; otherwise every field present in the mutation data is
   * treated as a client change.
   */
  baseState?: unknown;
}

export interface ResolvedMutation {
  data: unknown;
  retryWith?: "create" | "update";
}

export interface OfflineMutation {
  id: string;
  idempotencyKey: string;
  type: "create" | "update" | "delete";
  resource: string;
  data?: unknown;
  objectId?: string;
  optimisticId?: string;
  serverId?: string;
  timestamp: number;
  retryCount: number;
  status: "pending" | "processing" | "failed" | "synced";
  error?: string;
}

export interface OfflineConfig {
  enabled?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  storage?: OfflineStorage;
  conflictResolution?: ConflictResolutionStrategy;
  onConflict?: (
    mutation: OfflineMutation,
    serverState: unknown,
    error: ConflictError
  ) => ResolvedMutation | "retry" | "discard";
  onIdRemapped?: (optimisticId: string, serverId: string) => void;
  dedupeWindowMs?: number;
  /**
   * Coordinate optimistic mutations, id-remaps, invalidations and queue flushing
   * across browser tabs via BroadcastChannel. Opt-in: pass `true` to enable
   * (default channel name), or a string to set a custom channel name. When
   * enabled, only one "leader" tab flushes the shared mutation queue, preventing
   * double-sends. Feature-detected: a no-op in React Native / Node where
   * BroadcastChannel is unavailable.
   */
  tabSync?: boolean | string;
}

export interface OfflineStorage {
  getMutations(): Promise<OfflineMutation[]>;
  addMutation(mutation: OfflineMutation): Promise<void>;
  updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void>;
  removeMutation(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  offline?: OfflineConfig;
  onError?: (error: Error) => void;
  onAuthError?: () => void;
  onSyncComplete?: () => void;
}

/**
 * Options for `list` that carry a `select` projection as a literal tuple, used
 * by the narrowing overloads to produce `Pick<T, K>` results.
 */
export interface ListOptionsWithSelect<T, K extends keyof T> {
  select: readonly K[];
  filter?: string;
  include?: string;
  cursor?: string;
  limit?: number;
  orderBy?: string;
  totalCount?: boolean;
}

export interface GetOptionsWithSelect<T, K extends keyof T> {
  select: readonly K[];
  include?: string;
}

/**
 * A map of RPC procedure names to their `input`/`output` shapes. Pass this as
 * the second type parameter of `ResourceClient`/`Repository` to get
 * compile-time checking of procedure names and payloads.
 *
 * @example
 * interface TodoProcedures {
 *   publish: { input: { id: string }; output: { success: boolean } };
 * }
 * const todos = client.resource<Todo, TodoProcedures>("/api/todos");
 * await todos.rpc("publish", { id: "1" }); // typed; unknown names rejected
 */
export interface ProcedureDef {
  input: unknown;
  output: unknown;
}

/**
 * Structural constraint for a procedures map. Written as a mapped type (rather
 * than an index signature) so that both `interface` and `type` declarations
 * with concrete procedure names satisfy it.
 */
export type ProceduresMap = { [name: string]: ProcedureDef };

export type AnyProcedures = Record<never, ProcedureDef>;

export interface ResourceClient<
  T extends { id: string },
  P extends Record<keyof P, ProcedureDef> = AnyProcedures
> {
  list<K extends keyof T>(
    options: ListOptionsWithSelect<T, K>
  ): Promise<PaginatedResponse<Pick<T, K>>>;
  list(options?: ListOptions): Promise<PaginatedResponse<T>>;
  get<K extends keyof T>(
    id: string,
    options: GetOptionsWithSelect<T, K>
  ): Promise<Pick<T, K>>;
  get(id: string, options?: GetOptions): Promise<T>;
  count(filter?: string): Promise<number>;
  aggregate(options: AggregateOptions): Promise<AggregationResponse>;
  search(query: string, options?: SearchOptions): Promise<SearchResponse<T>>;
  create(data: Partial<Omit<T, "id">>, options?: CreateOptions): Promise<T>;
  update(id: string, data: Partial<T>, options?: UpdateOptions): Promise<T>;
  replace(id: string, data: Omit<T, "id">, options?: UpdateOptions): Promise<T>;
  delete(id: string, options?: DeleteOptions): Promise<void>;
  batchCreate(items: Partial<Omit<T, "id">>[]): Promise<T[]>;
  batchUpdate(filter: string, data: Partial<T>): Promise<{ count: number }>;
  batchDelete(filter: string): Promise<{ count: number }>;
  subscribe(
    options?: SubscribeOptions,
    callbacks?: SubscriptionCallbacks<T>
  ): Subscription<T>;
  subscribeAggregate(
    options?: AggregateOptions,
    callbacks?: AggregateSubscriptionCallbacks
  ): AggregateSubscription;
  rpc<N extends keyof P>(name: N, input: P[N]["input"]): Promise<P[N]["output"]>;
  // Loose escape hatch: only active when no procedures map is declared
  // (`keyof P` is `never`), so a declared map rejects unknown names/inputs.
  rpc<TInput = unknown, TOutput = unknown>(
    name: [keyof P] extends [never] ? string : never,
    input: TInput
  ): Promise<TOutput>;
  query(): ResourceQueryBuilder<T>;
}

/**
 * Minimal interface for resource clients used by React hooks.
 * This allows both library ResourceClient and generated TypedResourceClient to be used.
 */
export interface LiveListResourceClient<T extends { id: string }> {
  list(options?: {
    filter?: string;
    select?: string[];
    include?: string;
    cursor?: string;
    limit?: number;
    orderBy?: string;
    totalCount?: boolean;
  }): Promise<{ items: T[]; nextCursor: string | null; hasMore: boolean; totalCount?: number }>;
  create(data: Partial<Omit<T, "id">>, options?: { optimistic?: boolean; optimisticId?: string }): Promise<T>;
  update(id: string, data: Partial<T>, options?: { optimistic?: boolean }): Promise<T>;
  delete(id: string, options?: { optimistic?: boolean }): Promise<void>;
  subscribe(
    options?: { filter?: string; include?: string; resumeFrom?: number; skipExisting?: boolean; knownIds?: string[] },
    callbacks?: SubscriptionCallbacks<T>
  ): Subscription<T>;
}

/**
 * Minimal interface for search functionality used by React hooks.
 */
export interface SearchableResourceClient<T extends { id: string }> {
  search(query: string, options?: { filter?: string; limit?: number; offset?: number; highlight?: boolean }): Promise<{ items: T[]; total: number; highlights?: Record<string, Record<string, string[]>> }>;
}

export interface Subscription<T> {
  readonly state: SubscriptionState<T>;
  readonly items: T[];
  unsubscribe(): void;
  reconnect(): void;
}

/**
 * Interface for typed LiveQuery objects from generated code.
 * These can be passed directly to useLiveList for type-safe queries.
 *
 * @example
 * // Generated LiveQuery with type-safe includes and select
 * const query = client.resources.todos.filter('completed==true').include('category').select('id', 'title');
 * const { items } = useLiveList(query);
 * // items type: (Pick<todos, 'id' | 'title'> & { category?: categories | null })[]
 */
export interface LiveQueryLike<T extends { id: string } = { id: string }, Included = unknown, Selected extends keyof T = keyof T> {
  readonly _type: T;
  readonly _included: Included;
  readonly _selected: Selected;
  readonly _path: string;
  readonly _options: {
    filter?: string;
    orderBy?: string;
    limit?: number;
    select?: string[];
    include?: string;
  };
}

export interface PaginatedQuery<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly error: Error | null;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  setFilter(filter: string): void;
  setOrderBy(orderBy: string): void;
}

export interface ReactiveAggregate {
  readonly groups: AggregationGroup[];
  readonly isLoading: boolean;
  readonly error: Error | null;
  refresh(): Promise<void>;
  setOptions(options: AggregateOptions): void;
}

/**
 * @deprecated Use the `JWTClient` type from the client package instead.
 * This alias is kept for backward compatibility.
 */
export type JWTClientInterface = JWTClient;

export interface CheckAuthResult<TUser = unknown> {
  user: TUser | null;
  expiresAt?: Date;
}

export interface CovaraClient {
  readonly transport: Transport;
  readonly offline?: OfflineManager;
  readonly auth: AuthManager;
  readonly jwt?: JWTClient;
  /** Typed billing client for checkout, subscriptions, credits and the portal. */
  readonly billing: BillingClient;
  resource<T extends { id: string }, P extends Record<keyof P, ProcedureDef> = AnyProcedures>(
    path: string
  ): ResourceClient<T, P>;
  setAuthToken(token: string): void;
  clearAuthToken(): void;
  setAuthErrorHandler(handler: () => void): void;
  getPendingCount(): Promise<number>;
  checkAuth<TUser = unknown>(url?: string): Promise<CheckAuthResult<TUser>>;
  /**
   * The shared LiveQuery cache. React hooks acquire/release queries here so they
   * can be invalidated and prefetched centrally.
   */
  readonly queryCache: LiveQueryCache;
  /**
   * Mark matching cached LiveQuery stores stale and refetch them.
   * @param target a resource path / prefix string, or a predicate over (path, options).
   * @returns the number of cached queries refreshed.
   */
  invalidate(target: InvalidateTarget): number;
  /**
   * Warm the LiveQuery cache for a resource so a later `useLiveList` reads from
   * cache immediately. Resolves once the initial fetch completes.
   */
  prefetch(
    resource: string,
    options?: LiveQueryOptionsLike
  ): Promise<void>;
}

export interface LiveQueryOptionsLike {
  filter?: string;
  include?: string;
  orderBy?: string;
  limit?: number;
  subscriptionMode?: string;
  select?: string[];
}
