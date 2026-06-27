import {
  Table,
  TableConfig,
  AnyColumn,
  InferSelectModel,
  InferInsertModel,
  SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";
import type { Context as HonoContext } from "hono";
import type {
  EndpointCaptchaConfig,
  EndpointPowConfig,
  OverflowMechanism,
  ResourceCaptchaConfig,
  ResourceCostConfig,
  ResourcePowConfig,
} from "@/abuse/config";

 
export type DrizzleDatabase = any;
 
export type DrizzleTransaction = any;

export type EventType =
  | "added"
  | "existing"
  | "changed"
  | "removed"
  | "invalidate";

export interface BaseEvent {
  id: string;
  subscriptionId: string;
  seq: number;
  timestamp: number;
}

export interface EventMeta {
  optimisticId?: string;
}

export interface AddedEvent<T = Record<string, unknown>> extends BaseEvent {
  type: "added";
  object: T;
  meta?: EventMeta;
}

export interface ExistingEvent<T = Record<string, unknown>> extends BaseEvent {
  type: "existing";
  object: T;
}

export interface ChangedEvent<T = Record<string, unknown>> extends BaseEvent {
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

export type SubscriptionEvent<T = Record<string, unknown>> =
  | AddedEvent<T>
  | ExistingEvent<T>
  | ChangedEvent<T>
  | RemovedEvent
  | InvalidateEvent;

export interface ChangelogEntry {
  seq: number;
  resource: string;
  type: "create" | "update" | "delete";
  objectId: string;
  object?: Record<string, unknown>;
  previousObject?: Record<string, unknown>;
  timestamp: number;
  // ID of the authenticated user who performed the mutation, when known.
  userId?: string;
}

export interface Subscription {
  id: string;
  createdAt: Date;
  resource: string;
  filter: string;
  authId: string | null;
  handlerId: string;
  relevantObjectIds: Set<string>;
  lastSeq: number;
  scopeFilter?: string;
  authExpiresAt?: Date | null;
  include?: string;
  // The subscriber's user context, captured at subscribe time, so the server can
  // enforce each included relation's target read scope per-subscriber when
  // embedding relations in pushed events (matching the read path).
  user?: UserContext | null;
}

export interface PaginationParams {
  cursor?: string;
  limit: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface ProjectionParams {
  select?: string[];
}

export interface AggregationParams {
  groupBy?: string[];
  sum?: string[];
  avg?: string[];
  count?: boolean;
  min?: string[];
  max?: string[];
}

export interface AggregationResult {
  groups: Array<{
    key: Record<string, unknown> | null;
    count?: number;
    sum?: Record<string, number>;
    avg?: Record<string, number>;
    min?: Record<string, number | string>;
    max?: Record<string, number | string>;
  }>;
}

export interface CustomOperator {
  convert: (lhs: SQLWrapper, rhs: SQLWrapper) => SQLWrapper;
  execute: (lhs: unknown, rhs: unknown) => boolean;
}

export type WriteEffect =
  | { type: "create"; resource: string }
  | { type: "update"; resource: string; ids?: string[] }
  | { type: "delete"; resource: string; ids?: string[] };

export interface ProcedureContext<
  TConfig extends TableConfig = TableConfig,
  TDb extends DrizzleDatabase = DrizzleDatabase,
> {
  db: TDb;
  schema: Table<TConfig>;
  user: UserContext | null;
  req: Request | null;
  context: HonoContext | null;
}

export interface ProcedureDefinition<
  TInput = unknown,
  TOutput = unknown,
  TDb extends DrizzleDatabase = DrizzleDatabase,
> {
  input?: z.ZodSchema<TInput>;
  output?: z.ZodSchema<TOutput>;
  writeEffects?: WriteEffect[];
  handler: (ctx: ProcedureContext<TableConfig, TDb>, input: TInput) => Promise<TOutput>;
  /** Token-bucket cost charged when abuseProtection budget is enabled. */
  cost?: number;
  /** Optional proof-of-work gate for this procedure. */
  pow?: EndpointPowConfig;
  /** Optional CAPTCHA gate for this procedure (BETA). */
  captcha?: EndpointCaptchaConfig;
  /** Override the budget-overflow mechanism for this procedure. */
  overflow?: OverflowMechanism;
}

export interface LifecycleHooks<TConfig extends TableConfig = TableConfig> {
  onBeforeCreate?: (
    ctx: ProcedureContext<TConfig>,
    data: InferInsertModel<Table<TConfig>>
  ) => Promise<InferInsertModel<Table<TConfig>> | void>;
  onAfterCreate?: (
    ctx: ProcedureContext<TConfig>,
    created: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
  onBeforeUpdate?: (
    ctx: ProcedureContext<TConfig>,
    id: string,
    data: Partial<InferSelectModel<Table<TConfig>>>
  ) => Promise<Partial<InferSelectModel<Table<TConfig>>> | void>;
  onAfterUpdate?: (
    ctx: ProcedureContext<TConfig>,
    updated: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
  onBeforeDelete?: (
    ctx: ProcedureContext<TConfig>,
    id: string
  ) => Promise<void>;
  onAfterDelete?: (
    ctx: ProcedureContext<TConfig>,
    deleted: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
}

export interface UserContext {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  emailVerified: Date | null;
  sessionId: string;
  sessionExpiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ScopeFunction {
  (user: UserContext): CompiledScope | Promise<CompiledScope>;
}

export interface ScopeConfig {
  scope?: ScopeFunction;
  read?: ScopeFunction;
  create?: ScopeFunction;
  update?: ScopeFunction;
  delete?: ScopeFunction;
  subscribe?: ScopeFunction;
  // `true` makes read + subscribe public (writes still require auth). The object
  // form opts each operation in explicitly, including create/update/delete for
  // fully-public resources.
  public?:
    | boolean
    | {
        read?: boolean;
        subscribe?: boolean;
        create?: boolean;
        update?: boolean;
        delete?: boolean;
      };
}

export interface CompiledScope {
  toString(): string;
  isEmpty(): boolean;
  and(other: CompiledScope): CompiledScope;
  or(other: CompiledScope): CompiledScope;
}

export interface RateLimitConfig {
  windowMs?: number;
  maxRequests?: number;
}

export interface BatchConfig {
  create?: number;
  update?: number;
  replace?: number;
  delete?: number;
}

export interface SSEConfig {
  maxSubscriptionsPerUser?: number;
  maxSubscriptionsPerIP?: number;
  maxTotalSubscriptions?: number;
  heartbeatMs?: number;
  maxQueueBytes?: number;
  onBackpressure?: "drop" | "invalidate" | "disconnect";
  // Debounce window (ms) for recomputing live aggregations after a mutation.
  aggregateDebounceMs?: number;
  // Interval (ms) at which each live subscription re-resolves its auth scope so
  // out-of-band permission changes (e.g. losing org membership) emit added/removed
  // without waiting for a reconnect. Default 30000; set to 0 to disable. Only the
  // DB scan runs when the resolved scope actually changes. Reflects changes the
  // scope resolver itself recomputes (e.g. resolvers that query current
  // membership/roles); a resolver reading only static fields off the captured user
  // still requires a reconnect.
  scopeRecheckMs?: number;
}

export interface FilterConfig {
  maxLength?: number;
  maxDepth?: number;
  maxNodes?: number;
  allowedOperators?: string[];
  allowedFields?: string[];
}

export interface FieldPolicies {
  readable?: string[];
  writable?: string[];
  filterable?: string[];
  sortable?: string[];
  aggregatable?: {
    groupBy?: string[];
    metrics?: string[];
  };
}

export interface ResourceCapabilities {
  enableAggregations?: boolean;
  enableBatch?: boolean;
  enableSubscribe?: boolean;
  enableCreate?: boolean;
  enableUpdate?: boolean;
  enableDelete?: boolean;
}

export type RelationType = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

export interface RelationConfig {
  resource: string;
  schema: unknown;
  type: RelationType;
  foreignKey: AnyColumn;
  references: AnyColumn;
  through?: {
    schema: unknown;
    sourceKey: AnyColumn;
    targetKey: AnyColumn;
  };
  strategy?: "eager" | "lazy";
  defaultSelect?: string[];
  filterable?: boolean;
  subscribeToChanges?: boolean;
}

export interface RelationsConfig {
  [relationName: string]: RelationConfig;
}

export interface IncludeSpec {
  relation: string;
  select?: string[];
  filter?: string;
  limit?: number;
  offset?: number;
  nested?: IncludeSpec[];
}

export interface IncludeConfig {
  maxDepth?: number;
  defaultLimit?: number;
  allowNestedFilters?: boolean;
  customOperators?: Record<string, CustomOperator>;
}

export interface SearchFieldConfig {
  weight?: number;
  searchable?: boolean;
  analyzer?: string;
}

export interface ResourceSearchConfig {
  enabled?: boolean;
  indexName?: string;
  fields?: string[] | Record<string, SearchFieldConfig>;
  autoIndex?: boolean;
  // Route auto-index/delete through a durable KV-backed outbox that is drained
  // with retries, instead of indexing inline. Guarantees at-least-once DB->index
  // convergence across transient search-backend failures and restarts. Requires
  // a configured global KV. Off by default.
  outbox?: boolean;
  // Called when an auto-index/delete still fails after a retry. Use it to
  // enqueue a re-index so the search index reconciles with the database.
  onIndexError?: (info: {
    operation: "index" | "delete";
    id: string;
    index: string;
    error: unknown;
  }) => void | Promise<void>;
}

export interface ETagResourceConfig {
  versionField?: string;
  updatedAtField?: string;
  idField?: string;
  algorithm?: "weak" | "strong";
}

export interface ResourceConfig<
  TConfig extends TableConfig,
  TTable extends Table<TConfig>,
> {
  db: DrizzleDatabase;
  id: AnyColumn<{ tableName: TTable["_"]["name"] }>;
  // Whether the db supports interactive transactions. Auto-detected when omitted
  // (Cloudflare D1 -> false, since it has no BEGIN/COMMIT; everything else -> true).
  // Set explicitly to override detection for a custom/unrecognized driver.
  transactions?: boolean;
  etag?: ETagResourceConfig;
  batch?: BatchConfig;
  pagination?: {
    defaultLimit?: number;
    maxLimit?: number;
    cursorMaxAgeMs?: number;
    nullsPosition?: "first" | "last";
  };
  // Secret for signing this resource's pagination cursors (HMAC-SHA256). Falls
  // back to the global secret (setGlobalCursorSigningSecret) when omitted; set
  // to `null` to disable signing for this resource even if a global secret is
  // configured.
  cursorSigningSecret?: string | null;
  rateLimit?: RateLimitConfig;
  // Inline per-operation token-bucket costs (charged when abuseProtection's
  // budget is enabled). Preferred over `rateLimit` for cost-weighted limiting.
  cost?: ResourceCostConfig;
  // Optional proof-of-work gate. `true` gates create/update/delete at the
  // default difficulty; an object can override difficulty/trust-hook and the
  // set of gated operations.
  pow?: ResourcePowConfig;
  // Optional CAPTCHA gate (BETA). `true` gates create/update/delete; an object
  // can supply an action / risk hook / the set of gated operations.
  captcha?: ResourceCaptchaConfig;
  // Override the budget-overflow mechanism for this resource ("pow" | "captcha").
  overflow?: OverflowMechanism;
  auth?: ScopeConfig;
  procedures?: Record<string, ProcedureDefinition<any, any>>;
  hooks?: LifecycleHooks<TConfig>;
  customOperators?: Record<string, CustomOperator>;
  sse?: SSEConfig;
  filter?: FilterConfig;
  fields?: FieldPolicies;
  capabilities?: ResourceCapabilities;
  generatedFields?: string[];
  relations?: RelationsConfig;
  /**
   * Auto-discover relations from the Drizzle schema's foreign keys (belongsTo
   * from this table's FKs; hasMany from other registered resources' FKs that
   * reference this table). Explicit `relations` always win over discovered
   * ones. Discovered relations are still lazy — only loaded via `?include=`.
   */
  autoRelations?: boolean;
  include?: IncludeConfig;
  search?: ResourceSearchConfig;
  softDelete?: SoftDeleteConfig;
  // Enable write-through of nested relation objects in POST bodies. When true,
  // a create payload may embed `belongsTo` parents and `hasMany`/`hasOne`
  // children under their relation names; they are created in one transaction
  // and foreign keys wired automatically. Off by default.
  nestedWrites?: boolean;
  // Reject request bodies containing unknown fields (Zod strict mode) on
  // create/update instead of silently ignoring them. Off by default.
  strictInput?: boolean;
  // Computed/virtual fields added to every response (and subscription event).
  // Each function receives the full row (before read-masking) and returns the
  // value; the key is added to the serialized output. Computed fields are not
  // persisted and are exempt from `fields.readable` masking.
  computed?: Record<string, (row: Record<string, unknown>) => unknown>;
}

export interface SoftDeleteConfig {
  // Column used as the deletion marker. A row is considered deleted when this
  // column is non-null. On DELETE the column is set (instead of removing the
  // row); reads exclude deleted rows unless `?withDeleted=true` is passed.
  field: string;
  // Produces the value written on delete. Defaults to the current ISO
  // timestamp. Use e.g. `() => Date.now()` for integer columns.
  deletedValue?: () => unknown;
}
