import {
  InferInsertModel,
  Table,
  TableConfig,
  InferSelectModel,
  count,
  getTableName,
  SQL,
  AnyColumn,
  and,
  eq,
  isNull,
  getTableColumns,
  inArray,
} from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import z, { ZodError } from "zod";
import { v4 as uuidv4 } from "uuid";

import { createResourceFilter } from "./filter";
import { recordCreate, recordUpdate, recordDelete, changelog } from "./changelog";
import {
  createSubscription,
  removeSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  sendExistingItems,
  sendCatchupEvents,
  applyScopeChange,
  registerKnownIds,
  registerResourceMask,
  registerAggregateWatcher,
  takeRenderer,
} from "./subscription";
import {
  createPagination,
  parseOrderBy,
  getGlobalCursorSigningSecret,
} from "./pagination";
import {
  parseSelect,
  applyProjection,
  parseAggregationParams,
  buildAggregationSelections,
  buildHavingCondition,
  transformAggregationResults,
  canonicalizeAggregation,
} from "./query";
import {
  executeProcedure,
  executeBeforeCreate,
  executeAfterCreate,
  executeBeforeUpdate,
  executeAfterUpdate,
  executeBeforeDelete,
  executeAfterDelete,
} from "./procedures";
import { trackMutations, isTrackedDb } from "./track-mutations";
import { makeTxRunner } from "./transaction";
import { normalizeResourceConfig, type ResourceConfigInput } from "./column-ref";
import {
  ResourceConfig,
  CustomOperator,
  ProcedureDefinition,
  LifecycleHooks,
  ProcedureContext,
  DrizzleTransaction,
  UserContext,
} from "./types";
import { createSearchHandler, SearchHandlerOptions } from "./search";
import { hasGlobalSearch, getGlobalSearch } from "@/search";
import { hasGlobalKV } from "@/kv";
import { enqueueSearchOp, startSearchOutboxDrainer } from "./search-outbox";
import {
  NotFoundError,
  ValidationError,
  BatchLimitError,
  FilterParseError,
  formatZodError,
} from "./error";
import { createScopeResolver, combineScopes, Operation } from "@/auth/scope";
import { allScope } from "@/auth/rsql";
import { isAdminBypassRequest } from "@/server/admin-bypass";
import { createRateLimiter } from "@/middleware/rateLimit";
import { createAbuseMiddleware, resourceHasAbuseConfig } from "@/abuse/middleware";
import {
  discoverRelations,
  parseInclude,
  RelationLoader,
  RelationsConfig,
} from "./relations";
import { registerResourceRelations } from "./relation-registry";
import { registerResourceSchema, setResourceMountPath } from "@/ui/schema-registry";
import { getUser } from "@/server/context";
import { getClientIP, readJsonBody } from "@/server/request";
import { createSSEStream } from "@/server/sse";
import { getLogger } from "@/server/logger";
import { setETagHeader, validateIfMatch, handleConditionalGet, generateETag } from "./etag";
import { PreconditionFailedError } from "./error";

const DEFAULT_BATCH_LIMITS = {
  create: 100,
  update: 100,
  replace: 100,
  delete: 100,
};

const DEFAULT_PAGINATION = {
  defaultLimit: 20,
  maxLimit: 100,
};

const resourceRegistry = new Map<
  string,
  { schema: Table<TableConfig>; config: { relations?: RelationsConfig } }
>();

export const getResourceRegistry = () => resourceRegistry;

export const useResource = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  rawConfig: ResourceConfigInput<TConfig, Table<TConfig>>
): Hono => {
  // Column-reference config fields accept Drizzle columns (preferred) or names
  // (deprecated); normalize them to names so the rest of the layer is unchanged.
  const config = normalizeResourceConfig(rawConfig);
  const db = config.db;
  const resourceName = getTableName(schema);
  const idColumnName = config.id.name;
  // Interactive transactions everywhere except Cloudflare D1 (no BEGIN/COMMIT).
  // On D1, single-statement mutations auto-commit atomically and multi-statement
  // ones fall back to db.batch; see makeTxRunner.
  const txRunner = makeTxRunner(db, config.transactions);

  resourceRegistry.set(resourceName, {
    schema: schema as Table<TableConfig>,
    config: { relations: config.relations as RelationsConfig | undefined },
  });

  // Resolved relations (explicit over auto-discovered) for relation-path filter
  // scopes. Always discovers from foreign keys — independent of `autoRelations`,
  // which only governs eager relation loading — so a trusted scope can traverse
  // declared FKs with zero config. Resolved lazily (and memoized) on first use so
  // the full resource registry is populated. User filters can never reach these:
  // relation paths in `?filter=` are rejected before conversion.
  let resolvedRelationsMemo: RelationsConfig | undefined;
  registerResourceRelations(resourceName, () => {
    if (!resolvedRelationsMemo) {
      resolvedRelationsMemo = {
        ...discoverRelations(schema as Table<TableConfig>, resourceRegistry),
        ...((config.relations ?? {}) as RelationsConfig),
      };
    }
    return resolvedRelationsMemo;
  });

  // Default capabilities: all enabled unless explicitly disabled
  const capabilities = {
    enableCreate: config.capabilities?.enableCreate ?? true,
    enableUpdate: config.capabilities?.enableUpdate ?? true,
    enableDelete: config.capabilities?.enableDelete ?? true,
    enableSubscribe: config.capabilities?.enableSubscribe ?? true,
    enableAggregations: config.capabilities?.enableAggregations ?? true,
    enableBatch: config.capabilities?.enableBatch ?? !!config.batch,
  };

  registerResourceSchema(resourceName, schema as Table<TableConfig>, db, config.id, {
    relations: config.relations as RelationsConfig | undefined,
    auth: config.auth,
    batch: config.batch,
    capabilities,
    sseEnabled: !!config.sse,
    procedures: config.procedures ? Object.keys(config.procedures) : undefined,
    generatedFields: config.generatedFields,
    fields: config.fields,
  });

  const relationLoader =
    config.relations || config.autoRelations
      ? new RelationLoader(
          db,
          schema as Table<TableConfig>,
          (config.relations ?? {}) as RelationsConfig<TableConfig>,
          resourceRegistry,
          config.include,
          config.autoRelations === true
        )
      : null;

  // Create a subscription relation loader for pushing updates with relations.
  // It enforces each included relation's target read scope for the SUBSCRIBER
  // (captured at subscribe time), so a relation embedded in a subscription event
  // can never reveal rows that subscriber couldn't read directly — matching the
  // read path's scope enforcement.
  const subscriptionRelationLoader = relationLoader
    ? async <T extends Record<string, unknown>>(
        items: T[],
        include: string,
        user: UserContext | null
      ): Promise<T[]> => {
        const includeSpecs = parseInclude(include);
        if (includeSpecs.length === 0) return items;
        return relationLoader.loadRelationsForItems(items, includeSpecs, idColumnName, 0, {
          user,
          enforceScope: true,
        }) as Promise<T[]>;
      }
    : undefined;

  // Merge relations marked `strategy: "eager"` with the client's explicit
  // ?include= specs. Explicitly-requested specs win (so their filter/limit/
  // nested overrides the bare eager spec); lazy/unset relations only load when
  // explicitly included.
  const resolveIncludeSpecs = (includeQuery: string | undefined) => {
    const requested = parseInclude(includeQuery);
    if (!relationLoader) return requested;
    const eager = relationLoader.getEagerIncludes();
    if (eager.length === 0) return requested;
    const byName = new Map<string, (typeof requested)[number]>();
    for (const spec of eager) byName.set(spec.relation, spec);
    for (const spec of requested) byName.set(spec.relation, spec);
    return Array.from(byName.values());
  };

  const router = new Hono();

  // Capture mount path on first request for OpenAPI auto-discovery
  let mountPathCaptured = false;
  router.use("*", async (c, next) => {
    if (!mountPathCaptured) {
      setResourceMountPath(resourceName, c.req.routePath.replace(/\/\*$/, ""));
      mountPathCaptured = true;
    }
    await next();
  });

  const filterer = createResourceFilter(schema, config.customOperators ?? {});

  // Untrusted user `?filter=` input may not traverse relations: a relation path
  // would let a client join into other tables (e.g. probe organization
  // membership). Auth scopes are trusted and converted directly, so they may.
  const rejectRelationPathFilter = (filterQuery: string): void => {
    if (
      filterQuery &&
      filterQuery.trim() !== "" &&
      filterer.compile(filterQuery).requiresJoin()
    ) {
      throw new FilterParseError(
        "Relation paths are not allowed in filter queries"
      );
    }
  };

  // Resource cursor signing secret overrides the global one; an explicit `null`
  // opts this resource out even when a global secret is set. `undefined` (unset)
  // falls back to the global secret.
  const cursorSigningSecret =
    (config.cursorSigningSecret !== undefined
      ? config.cursorSigningSecret
      : getGlobalCursorSigningSecret()) || undefined;

  const pagination = createPagination(schema, config.id, {
    ...(config.pagination ?? DEFAULT_PAGINATION),
    cursorSigningSecret,
  });

  const scopeResolver = createScopeResolver(config.auth, resourceName);

  const baseInsertSchema = createInsertSchema(schema);
  const updateSchema = createUpdateSchema(schema);

  const generatedFieldsPartial = config.generatedFields?.length
    ? Object.fromEntries(config.generatedFields.map((f) => [f, true] as const))
    : null;

  const insertSchemaBase = generatedFieldsPartial
    ? (baseInsertSchema.partial as any)(generatedFieldsPartial)
    : baseInsertSchema;

  // Strict mode rejects unknown fields instead of silently dropping them.
  const insertSchema = config.strictInput ? (insertSchemaBase as any).strict() : insertSchemaBase;
  const strictUpdateSchema = config.strictInput ? (updateSchema as any).strict() : updateSchema;

  const parseInsert = (data: unknown) => {
    try {
      return insertSchema.parse(data) as InferInsertModel<Table<TConfig>>;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const parseMultiInsert = (data: unknown) => {
    try {
      return z.object({ items: z.array(insertSchema) }).parse(data) as {
        items: InferInsertModel<Table<TConfig>>[];
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const parseUpdate = (data: unknown) => {
    try {
      return strictUpdateSchema.parse(data) as Partial<InferSelectModel<Table<TConfig>>>;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const batchConfig = { ...DEFAULT_BATCH_LIMITS, ...config.batch };
  const hooks = config.hooks;
  const procedures = config.procedures ?? {};

  const rateLimitMiddleware = config.rateLimit
    ? createRateLimiter({
        windowMs: config.rateLimit.windowMs ?? 60000,
        maxRequests: config.rateLimit.maxRequests ?? 100,
      })
    : null;

  // Create a tracked db for procedures if not already tracked
  // This ensures mutations in procedures are automatically recorded to changelog
  const trackedDb = isTrackedDb(db)
    ? db
    : trackMutations(db, {
        [resourceName]: { table: schema, id: config.id },
      });

  const etagConfig = config.etag;

  // Field-level read masking: if `fields.readable` is configured, it is an
  // allowlist of TABLE COLUMNS that may be returned. Non-readable columns are
  // stripped from every response (REST + subscription events + initial
  // snapshot). Non-column keys (relations, computed fields, _etag) always pass
  // through so includes keep working.
  const readableSet = config.fields?.readable
    ? new Set(config.fields.readable)
    : null;
  const computedFields = config.computed
    ? Object.entries(config.computed)
    : null;
  const tableColumnNames = new Set(Object.keys(getTableColumns(schema)));
  // Serializer applied to every read response + subscription event: first adds
  // computed/virtual fields (from the full row), then strips non-readable table
  // columns. Computed fields and relation/computed keys survive masking.
  const maskReadable = <T extends Record<string, unknown>>(item: T): T => {
    if (item === null || typeof item !== "object") return item;
    if (!readableSet && !computedFields) return item;

    let result: Record<string, unknown> = item;
    if (computedFields) {
      result = { ...item };
      for (const [key, fn] of computedFields) {
        result[key] = fn(item);
      }
    }
    if (!readableSet) return result as T;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      if (tableColumnNames.has(key) && !readableSet.has(key)) continue;
      out[key] = value;
    }
    return out as T;
  };
  const maskReadableList = <T extends Record<string, unknown>>(items: T[]): T[] =>
    readableSet || computedFields ? items.map((i) => maskReadable(i)) : items;

  if (readableSet || computedFields) {
    registerResourceMask(resourceName, (item) => maskReadable(item));
  }

  // Mass-assignment protection: if `fields.writable` is configured, strip any
  // table columns the client tries to set that aren't in the allowlist. Applied
  // to client input BEFORE lifecycle hooks, so server-side hooks can still set
  // protected fields. Non-column keys (relation payloads) pass through.
  const writableSet = config.fields?.writable ? new Set(config.fields.writable) : null;
  // The primary key and generated fields are managed by the framework/DB, not
  // by mass-assignment policy — never strip them even if absent from `writable`.
  const writableExempt = new Set<string>([idColumnName, ...(config.generatedFields ?? [])]);
  const applyWritable = <T extends Record<string, unknown>>(data: T): T => {
    if (!writableSet || data === null || typeof data !== "object") return data;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (tableColumnNames.has(key) && !writableSet.has(key) && !writableExempt.has(key)) continue;
      out[key] = value;
    }
    return out as T;
  };

  const applyVersionBump = (
    existing: Record<string, unknown>,
    data: Record<string, unknown>
  ): Record<string, unknown> => {
    const versionField = etagConfig?.versionField;
    if (!versionField || data[versionField] !== undefined) return data;
    const current = Number(existing[versionField] ?? 0);
    if (Number.isNaN(current)) return data;
    return { ...data, [versionField]: current + 1 };
  };

  // Build a compare-and-swap predicate so the UPDATE only matches the exact row
  // version we validated If-Match against. This closes the read-validate-write
  // TOCTOU race: if a concurrent writer changed the row between our SELECT and
  // our UPDATE, zero rows match and we surface a 412 instead of a lost update.
  const buildCasPredicate = (
    existing: Record<string, unknown>
  ): SQL<unknown> | undefined => {
    if (!etagConfig) return undefined;
    const columns = getTableColumns(schema) as Record<string, any>;
    const field = etagConfig.versionField ?? etagConfig.updatedAtField;
    if (!field) return undefined;
    const column = columns[field];
    if (!column) return undefined;
    return eq(column, existing[field] as any);
  };

  const createProcedureContext = (c: Context): ProcedureContext<TConfig> => ({
    db: trackedDb,
    schema,
    user: getUser(c),
    req: c.req.raw,
    context: c,
  });

  const softDeleteConfig = config.softDelete;
  const softDeleteColumn = softDeleteConfig
    ? (getTableColumns(schema) as Record<string, any>)[softDeleteConfig.field]
    : undefined;
  const softDeleteValue = (): unknown =>
    softDeleteConfig?.deletedValue ? softDeleteConfig.deletedValue() : new Date().toISOString();

  const excludeSoftDeleted = (base: SQL<unknown> | undefined): SQL<unknown> | undefined => {
    if (!softDeleteColumn) return base;
    const notDeleted = isNull(softDeleteColumn);
    return base ? and(base, notDeleted) : notDeleted;
  };

  const resolveScope = async (c: Context, operation: Operation) => {
    if (c.get("impersonatedId")) {
      return scopeResolver.resolve(operation, getUser(c));
    }
    if (await isAdminBypassRequest(c)) return allScope();
    return scopeResolver.resolve(operation, getUser(c));
  };

  const requireScope = async (c: Context, operation: Operation) => {
    if (c.get("impersonatedId")) {
      await scopeResolver.requirePermission(operation, getUser(c));
      return;
    }
    if (await isAdminBypassRequest(c)) return;
    await scopeResolver.requirePermission(operation, getUser(c));
  };

  const applyFilters = async (
    c: Context,
    operation: Operation,
    additionalFilter?: string
  ): Promise<SQL<unknown> | undefined> => {
    const scope = await resolveScope(c, operation);

    const filterQuery = additionalFilter ?? c.req.query("filter") ?? "";
    // The scope (developer-authored) may traverse relation paths; the user filter
    // may not — reject a join in user input so a client can't probe other tables.
    rejectRelationPathFilter(filterQuery);
    const combinedFilter = combineScopes(scope, filterQuery);

    let base: SQL<unknown> | undefined;
    if (combinedFilter === "" || combinedFilter === "*") {
      base = filterQuery ? (filterer.convert(filterQuery) as SQL<unknown>) : undefined;
    } else {
      base = filterer.convert(combinedFilter) as SQL<unknown>;
    }

    // Exclude soft-deleted rows from every operation unless the caller opts in
    // with ?withDeleted=true. This keeps deleted rows invisible to reads,
    // updates, and (re-)deletes alike.
    if (softDeleteColumn && c.req.query("withDeleted") !== "true") {
      const notDeleted = isNull(softDeleteColumn);
      return base ? and(base, notDeleted) : notDeleted;
    }

    return base;
  };

  if (rateLimitMiddleware) {
    router.use("*", rateLimitMiddleware);
  }

  const abuseMiddlewareConfig = {
    cost: config.cost,
    pow: config.pow,
    captcha: config.captcha,
    overflow: config.overflow,
    procedures: config.procedures,
  };
  if (resourceHasAbuseConfig(abuseMiddlewareConfig)) {
    router.use("*", createAbuseMiddleware(resourceName, abuseMiddlewareConfig));
  }

  if (batchConfig.create && batchConfig.create > 0) {
    router.post("/batch", async (c) => {
      await requireScope(c, "create");

      const data = parseMultiInsert(await readJsonBody(c));
      if (data.items.length > batchConfig.create!) {
        throw new BatchLimitError("create", batchConfig.create!, data.items.length);
      }

      const ctx = createProcedureContext(c);

      const processedItems = await Promise.all(
        data.items.map(async (item) => {
          const processed = await executeBeforeCreate(
            hooks,
            ctx,
            applyWritable(item as Record<string, unknown>) as typeof item
          );
          return processed;
        })
      );

      const created = await db.insert(schema).values(processedItems).returning();
      const createdArray = created as unknown as Record<string, unknown>[];

      for (const item of createdArray) {
        await executeAfterCreate(hooks, ctx, item as any);
        recordCreate(resourceName, String(item[idColumnName]), item, getUser(c)?.id);
        await indexDocument(String(item[idColumnName]), item);
      }

      await pushInsertsToSubscriptions(
        resourceName,
        filterer as any,
        createdArray,
        idColumnName,
        undefined,
        subscriptionRelationLoader
      );

      return c.json({ items: maskReadableList(created as Record<string, unknown>[]) });
    });

    // Bulk upsert: insert-or-update by primary key. New rows run create hooks +
    // emit added events; existing rows run update hooks + emit changed events.
    router.post("/batch/upsert", async (c) => {
      await requireScope(c, "create");
      await requireScope(c, "update");

      const data = parseMultiInsert(await readJsonBody(c));
      if (data.items.length > batchConfig.create!) {
        throw new BatchLimitError("create", batchConfig.create!, data.items.length);
      }

      const ctx = createProcedureContext(c);

      const loadPrev = async (
        runner: DrizzleTransaction | typeof db
      ): Promise<Map<string, Record<string, unknown>>> => {
        const ids = data.items
          .map((i) => (i as Record<string, unknown>)[idColumnName])
          .filter((v) => v !== undefined && v !== null);
        const existing = ids.length
          ? ((await runner.select().from(schema).where(inArray(config.id, ids as any))) as unknown as Record<string, unknown>[])
          : [];
        return new Map(existing.map((e) => [String(e[idColumnName]), e]));
      };

      // Run the before-hook for one item and return its (lazy) upsert statement.
      // The statement is wrapped so awaiting this promise doesn't execute the
      // builder (drizzle builders are thenable); callers run it explicitly.
      const buildUpsert = async (
        runner: DrizzleTransaction | typeof db,
        rawItem: unknown,
        prev: Map<string, Record<string, unknown>>
      ): Promise<{ stmt: any }> => {
        const item = applyWritable(rawItem as Record<string, unknown>);
        const id = String(item[idColumnName]);
        const hookData = prev.has(id)
          ? await executeBeforeUpdate(hooks, ctx, id, item as any)
          : await executeBeforeCreate(hooks, ctx, item as any);
        const setObj: Record<string, unknown> = { ...(hookData as Record<string, unknown>) };
        delete setObj[idColumnName];
        return {
          stmt: runner
            .insert(schema)
            .values(hookData as any)
            .onConflictDoUpdate({ target: config.id, set: setObj as any })
            .returning(),
        };
      };

      let upserted: Record<string, unknown>[];
      let previousMap: Map<string, Record<string, unknown>>;

      if (txRunner.interactive) {
        ({ upserted, previousMap } = await txRunner.run(async (tx: DrizzleTransaction) => {
          const prev = await loadPrev(tx);
          const out: Record<string, unknown>[] = [];
          // Interleave hook -> insert per item (a hook may observe prior upserts).
          for (const rawItem of data.items) {
            const { stmt } = await buildUpsert(tx, rawItem, prev);
            out.push(((await stmt) as any[])[0] as Record<string, unknown>);
          }
          return { upserted: out, previousMap: prev };
        }));
      } else {
        // No interactive transactions (D1): build every statement, then apply them
        // atomically with db.batch (D1's atomic primitive).
        previousMap = await loadPrev(db);
        const built: any[] = [];
        for (const rawItem of data.items) built.push((await buildUpsert(db, rawItem, previousMap)).stmt);
        const results = built.length ? await (db as any).batch(built) : [];
        upserted = (results as any[]).map((r) => (r as any[])[0] as Record<string, unknown>);
      }

      for (const item of upserted) {
        const id = String(item[idColumnName]);
        const previous = previousMap.get(id);
        if (previous) {
          await executeAfterUpdate(hooks, ctx, item as any);
          recordUpdate(resourceName, id, item, previous, getUser(c)?.id);
        } else {
          await executeAfterCreate(hooks, ctx, item as any);
          recordCreate(resourceName, id, item, getUser(c)?.id);
        }
        await indexDocument(id, item);
      }

      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        upserted,
        idColumnName,
        previousMap,
        subscriptionRelationLoader
      );

      return c.json({ items: maskReadableList(upserted) });
    });
  }

  if (batchConfig.update && batchConfig.update > 0) {
    router.patch("/batch", async (c) => {
      const filter = await applyFilters(c, "update");
      const data = parseUpdate(await readJsonBody(c));

      const result = await txRunner.run(async (tx: DrizzleTransaction) => {
        const beforeItems = (await tx.select().from(schema).where(filter)) as unknown as Record<string, unknown>[];

        if (beforeItems.length > batchConfig.update!) {
          throw new BatchLimitError("update", batchConfig.update!, beforeItems.length);
        }

        const ctx = createProcedureContext(c);

        let processedData = data;
        for (const item of beforeItems) {
          processedData = await executeBeforeUpdate(
            hooks,
            ctx,
            String(item[idColumnName]),
            processedData
          );
        }

        await tx.update(schema).set(processedData).where(filter);

        // Select by IDs, not by original filter, since the update may have changed fields used in the filter
        const ids = beforeItems.map((item) => item[idColumnName]);
        const afterItems = (await tx.select().from(schema).where(inArray(config.id, ids as any))) as unknown as Record<string, unknown>[];

        const previousMap = new Map<string, Record<string, unknown>>();
        for (let i = 0; i < beforeItems.length; i++) {
          const before = beforeItems[i]!;
          const after = afterItems[i]!;
          const id = String(before[idColumnName]);
          previousMap.set(id, before);
          await executeAfterUpdate(hooks, ctx, after as any);
        }

        return { count: afterItems.length, items: afterItems, previousMap };
      });

      // Record to changelog only after the transaction has committed, so a
      // rolled-back update never leaves a phantom entry.
      for (const item of result.items) {
        const id = String(item[idColumnName]);
        await recordUpdate(resourceName, id, item, result.previousMap.get(id), getUser(c)?.id);
        await indexDocument(id, item);
      }

      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        result.items,
        idColumnName,
        result.previousMap,
        subscriptionRelationLoader
      );

      return c.json({ count: result.count });
    });
  }

  if (batchConfig.delete && batchConfig.delete > 0) {
    router.delete("/batch", async (c) => {
      const filter = await applyFilters(c, "delete");

      const result = await txRunner.run(async (tx: DrizzleTransaction) => {
        const items = (await tx.select().from(schema).where(filter)) as unknown as Record<string, unknown>[];

        if (items.length > batchConfig.delete!) {
          throw new BatchLimitError("delete", batchConfig.delete!, items.length);
        }

        const ctx = createProcedureContext(c);

        for (const item of items) {
          await executeBeforeDelete(hooks, ctx, String(item[idColumnName]));
        }

        if (softDeleteConfig) {
          await tx
            .update(schema)
            .set({ [softDeleteConfig.field]: softDeleteValue() } as any)
            .where(filter);
        } else {
          await tx.delete(schema).where(filter);
        }

        const deletedIds: string[] = [];
        for (const item of items) {
          const id = String(item[idColumnName]);
          deletedIds.push(id);
          await executeAfterDelete(hooks, ctx, item as any);
        }

        return { count: items.length, deletedIds, items };
      });

      // Record to changelog only after the transaction has committed, so a
      // rolled-back delete never leaves a phantom entry.
      for (const item of result.items) {
        await recordDelete(resourceName, String(item[idColumnName]), item, getUser(c)?.id);
      }

      for (const id of result.deletedIds) {
        await deleteFromIndex(id);
      }

      await pushDeletesToSubscriptions(
        resourceName,
        result.deletedIds,
        result.items as Record<string, unknown>[]
      );

      return c.json({ count: result.count });
    });
  }

  let eventPollInterval: ReturnType<typeof setInterval> | null = null;
  let activeClients = 0;

  const startEventPolling = () => {
    if (eventPollInterval) return;

    eventPollInterval = setInterval(async () => {
      if (activeClients === 0) {
        stopEventPolling();
      }
    }, 30000);
  };

  const stopEventPolling = () => {
    if (eventPollInterval) {
      clearInterval(eventPollInterval);
      eventPollInterval = null;
    }
  };

  const sseConfig = {
    maxSubscriptionsPerUser: config.sse?.maxSubscriptionsPerUser ?? 10,
    maxSubscriptionsPerIP: config.sse?.maxSubscriptionsPerIP ?? 50,
    heartbeatMs: config.sse?.heartbeatMs ?? 20000,
    maxQueueBytes: config.sse?.maxQueueBytes ?? 65536,
    onBackpressure: config.sse?.onBackpressure ?? "invalidate",
    scopeRecheckMs: config.sse?.scopeRecheckMs ?? 30000,
  };

  const userSubscriptionCounts = new Map<string, number>();
  const ipSubscriptionCounts = new Map<string, number>();

  router.get("/subscribe", async (c) => {
    const user = getUser(c);
    const scope = await resolveScope(c, "subscribe");
    const filterQuery = c.req.query("filter") ?? "";
    const includeQuery = c.req.query("include");
    const handlerId = uuidv4();

    // Untrusted: a subscriber's own filter may not traverse relations (same rule
    // as the read path) — reject before opening the stream.
    if (filterQuery.trim() !== "" && filterer.compile(filterQuery).requiresJoin()) {
      throw new FilterParseError(
        "Relation paths are not allowed in filter queries"
      );
    }

    // A relation-path (join) scope can only be enforced live via the periodic
    // scope recheck (it can't be matched against rows in memory). If the recheck
    // is disabled the subscription would never reconcile, so fail fast instead of
    // silently serving an empty/stale stream.
    const scopeStr = scope.toString();
    const scopeNeedsJoin =
      scopeStr !== "*" && scopeStr !== "" && filterer.compile(scopeStr).requiresJoin();
    if (scopeNeedsJoin && !(config.auth && sseConfig.scopeRecheckMs > 0)) {
      throw new FilterParseError(
        "Relation-path subscribe scopes require sse.scopeRecheckMs > 0"
      );
    }

    const lastEventId = c.req.header("last-event-id");
    const resumeFromQuery = c.req.query("resumeFrom");
    const resumeFrom = lastEventId
      ? parseInt(lastEventId, 10)
      : resumeFromQuery
        ? parseInt(resumeFromQuery, 10)
        : undefined;

    const skipExisting = c.req.query("skipExisting") === "true";
    const knownIdsParam = c.req.query("knownIds");
    const knownIds = knownIdsParam ? knownIdsParam.split(",").filter(id => id.length > 0) : [];

    const userId = user?.id ?? "anonymous";
    const clientIP = getClientIP(c);

    const userCount = userSubscriptionCounts.get(userId) ?? 0;
    if (userCount >= sseConfig.maxSubscriptionsPerUser) {
      return c.json(
        {
          type: "/__covara/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerUser} subscriptions per user`,
        },
        429
      );
    }

    const ipCount = ipSubscriptionCounts.get(clientIP) ?? 0;
    if (ipCount >= sseConfig.maxSubscriptionsPerIP) {
      return c.json(
        {
          type: "/__covara/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerIP} subscriptions per IP`,
        },
        429
      );
    }

    const { writer, response } = createSSEStream({
      signal: c.req.raw.signal,
      maxQueueBytes: sseConfig.maxQueueBytes,
    });

    userSubscriptionCounts.set(userId, userCount + 1);
    ipSubscriptionCounts.set(clientIP, ipCount + 1);

    // covara/htmx: a one-shot token lets the htmx layer inject an HTML renderer
    // so this stream emits server-rendered fragments instead of JSON, reusing
    // all of this handler's scope/resume/heartbeat logic unchanged.
    const cvRendererToken = c.req.query("__cvRenderer");
    const cvRenderer = cvRendererToken ? takeRenderer(cvRendererToken) : undefined;
    registerHandler(handlerId, writer, sseConfig.onBackpressure, cvRenderer);
    activeClients++;
    startEventPolling();

    const currentSeq = await changelog.getCurrentSequence();
    writer.write(`id: ${currentSeq}\nevent: connected\ndata: ${JSON.stringify({ seq: currentSeq })}\n\n`);

    const heartbeat = setInterval(() => {
      if (writer.closed) {
        clearInterval(heartbeat);
        return;
      }
      writer.write(`: ping ${Date.now()}\n\n`);
    }, sseConfig.heartbeatMs);

    const subscriptionId = await createSubscription({
      resource: resourceName,
      filter: filterQuery,
      handlerId,
      authId: user?.id ?? null,
      scopeFilter: scope.toString() !== "*" ? scope.toString() : undefined,
      authExpiresAt: user?.sessionExpiresAt,
      include: includeQuery,
      // Captured so included relations in pushed events are scope-filtered for
      // this subscriber (the effective/impersonated user).
      user: user ?? null,
    });

    // Periodically re-resolve the auth scope so out-of-band permission changes
    // (e.g. losing org membership) emit added/removed without waiting for a
    // reconnect. The scope is otherwise frozen at connect time. Only enabled when
    // the resource has an auth scope configured; the DB scan runs only when the
    // resolved scope string actually changes.
    let currentScopeStr = scope.toString() !== "*" ? scope.toString() : undefined;
    const recheckScope = async () => {
      if (writer.closed) return;
      try {
        const freshScope = await resolveScope(c, "subscribe");
        const freshStr =
          freshScope.toString() !== "*" ? freshScope.toString() : undefined;
        // A join scope's string is stable even as the underlying membership
        // changes, so the string-equality short-circuit would never re-query it.
        // Force a re-query each tick for join scopes; the DB sees the new rows.
        const mustAlwaysRescan =
          !!freshStr && filterer.compile(freshStr).requiresJoin();
        if (freshStr === currentScopeStr && !mustAlwaysRescan) return;
        currentScopeStr = freshStr;

        const combinedFilter = combineScopes(freshScope, filterQuery);
        const baseFilter =
          combinedFilter && combinedFilter !== "*"
            ? (filterer.convert(combinedFilter) as SQL<unknown>)
            : undefined;
        const matchFilter = excludeSoftDeleted(baseFilter);
        const items = await db.select().from(schema).where(matchFilter);

        await applyScopeChange(
          subscriptionId,
          freshStr,
          items as Record<string, unknown>[],
          idColumnName,
          subscriptionRelationLoader
        );
      } catch {
        // Best effort: a transient scope-resolve/query error must not tear down
        // the live connection. The next tick retries.
      }
    };

    const scopeRecheck =
      config.auth && sseConfig.scopeRecheckMs > 0
        ? setInterval(() => {
            if (writer.closed) {
              clearInterval(scopeRecheck!);
              return;
            }
            void recheckScope();
          }, sseConfig.scopeRecheckMs)
        : null;

    const cleanup = async () => {
      clearInterval(heartbeat);
      if (scopeRecheck) clearInterval(scopeRecheck);
      activeClients--;

      userSubscriptionCounts.set(
        userId,
        Math.max(0, (userSubscriptionCounts.get(userId) ?? 1) - 1)
      );
      ipSubscriptionCounts.set(
        clientIP,
        Math.max(0, (ipSubscriptionCounts.get(clientIP) ?? 1) - 1)
      );

      if (activeClients === 0) {
        stopEventPolling();
      }

      await unregisterHandler(handlerId);
      await removeSubscription(subscriptionId);
    };

    writer.onClose(() => {
      void cleanup();
    });

    try {
      if (resumeFrom !== undefined) {
        // Replay the entries missed while disconnected to this one subscription.
        // On a clean replay, also seed relevantObjectIds with the current
        // matching set so subsequent live events classify correctly (changed/
        // removed, not added) for rows the client already holds — without it a
        // post-reconnect delete would be dropped and leave a ghost item.
        const result = await sendCatchupEvents(
          subscriptionId,
          resumeFrom,
          currentSeq,
          filterer as any,
          idColumnName,
          subscriptionRelationLoader
        );
        if (result === "replayed") {
          const combinedFilter = combineScopes(scope, filterQuery);
          const baseFilter = combinedFilter && combinedFilter !== "*"
            ? (filterer.convert(combinedFilter) as SQL<unknown>)
            : undefined;
          const filter = excludeSoftDeleted(baseFilter);
          const items = await db.select().from(schema).where(filter);
          const ids = (items as Record<string, unknown>[]).map(item => String(item[idColumnName]));
          await registerKnownIds(subscriptionId, ids);
        }
      } else if (skipExisting) {
        // Client already has data from paginated GET, just register known IDs
        if (knownIds.length > 0) {
          await registerKnownIds(subscriptionId, knownIds);
        }
        // If no knownIds provided but skipExisting is true, we need to query
        // matching items to populate relevantObjectIds for proper change tracking
        // This ensures removed events work correctly when items leave the filter scope
        else {
          const combinedFilter = combineScopes(scope, filterQuery);
          const baseFilter = combinedFilter && combinedFilter !== "*"
            ? (filterer.convert(combinedFilter) as SQL<unknown>)
            : undefined;
          const filter = excludeSoftDeleted(baseFilter);

          const items = await db.select().from(schema).where(filter);
          const ids = (items as Record<string, unknown>[]).map(item => String(item[idColumnName]));
          await registerKnownIds(subscriptionId, ids);
        }
      } else {
        const combinedFilter = combineScopes(scope, filterQuery);
        const baseFilter = combinedFilter && combinedFilter !== "*"
          ? (filterer.convert(combinedFilter) as SQL<unknown>)
          : undefined;
        const filter = excludeSoftDeleted(baseFilter);

        const items = await db.select().from(schema).where(filter);
        await sendExistingItems(
          subscriptionId,
          items as Record<string, unknown>[],
          idColumnName
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      writer.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`);
      writer.close();
      return response;
    }

    return response;
  });

  const runAggregate = async (
    filter: SQL<unknown> | undefined,
    params: ReturnType<typeof parseAggregationParams>
  ) => {
    const { groupByColumns, aggregateColumns } = buildAggregationSelections(
      schema,
      params
    );

    const columns = getTableColumns(schema);
    const selectObj: Record<string, unknown> = {
      ...groupByColumns,
      ...aggregateColumns,
    };

    let query = db.select(selectObj as any).from(schema);

    if (filter) {
      query = query.where(filter) as any;
    }

    if (params.groupBy.length > 0) {
      const groupByCols = params.groupBy.map((f) => columns[f]).filter(Boolean);
      query = (query as any).groupBy(...groupByCols);
    }

    if (params.having) {
      const havingCondition = buildHavingCondition(
        params.having,
        aggregateColumns,
        groupByColumns
      );
      if (havingCondition) {
        query = (query as any).having(havingCondition);
      }
    }

    const results = await query;
    return transformAggregationResults(results as Record<string, unknown>[], params);
  };

  router.get("/aggregate", async (c) => {
    const filter = await applyFilters(c, "read");
    const params = parseAggregationParams(c.req.query() as Record<string, unknown>);
    return c.json(await runAggregate(filter, params));
  });

  // Live aggregations: stream the aggregate result, then recompute and re-emit
  // whenever the resource is mutated (debounced). Recompute-on-change keeps the
  // result exact for any grouping/having combination without per-row tracking.
  router.get("/aggregate/subscribe", async (c) => {
    const user = getUser(c);
    const filter = await applyFilters(c, "read");
    const params = parseAggregationParams(c.req.query() as Record<string, unknown>);
    const handlerId = uuidv4();

    // In-memory matcher mirroring the aggregate's read scope + filter. Used to
    // skip recompute when a mutated row can't be in this subscription's scope
    // (e.g. another user's row), so a per-user aggregate doesn't recompute on
    // every other user's mutation. Falls back to recompute when the mutation
    // carries no row data or the aggregate is unscoped (matcher null).
    const readScope = await resolveScope(c, "read");
    const matcherFilter = combineScopes(readScope, c.req.query("filter") ?? "");
    const matcher =
      matcherFilter && matcherFilter !== "*" ? filterer.compile(matcherFilter) : null;
    const affectsAggregate = (changed?: Record<string, unknown>[]): boolean => {
      if (!changed || !matcher) return true;
      return changed.some((obj) => {
        try {
          return matcher.execute(obj);
        } catch {
          return true;
        }
      });
    };

    const userId = user?.id ?? "anonymous";
    const clientIP = getClientIP(c);

    const userCount = userSubscriptionCounts.get(userId) ?? 0;
    if (userCount >= sseConfig.maxSubscriptionsPerUser) {
      return c.json(
        {
          type: "/__covara/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerUser} subscriptions per user`,
        },
        429
      );
    }

    const ipCount = ipSubscriptionCounts.get(clientIP) ?? 0;
    if (ipCount >= sseConfig.maxSubscriptionsPerIP) {
      return c.json(
        {
          type: "/__covara/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerIP} subscriptions per IP`,
        },
        429
      );
    }

    const { writer, response } = createSSEStream({
      signal: c.req.raw.signal,
      maxQueueBytes: sseConfig.maxQueueBytes,
    });

    userSubscriptionCounts.set(userId, userCount + 1);
    ipSubscriptionCounts.set(clientIP, ipCount + 1);

    registerHandler(handlerId, writer, sseConfig.onBackpressure);
    activeClients++;
    startEventPolling();

    let lastFingerprint: string | undefined;
    const emit = async () => {
      if (writer.closed) return;
      try {
        const data = await runAggregate(filter, params);
        const seq = await changelog.getCurrentSequence();
        // Order-independent compare so a reordered-but-identical result (GROUP
        // BY has no stable ORDER BY) isn't resent.
        const fingerprint = canonicalizeAggregation(data);
        if (fingerprint === lastFingerprint) return;
        lastFingerprint = fingerprint;
        writer.write(`id: ${seq}\nevent: aggregate\ndata: ${JSON.stringify({ data, seq })}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        writer.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      }
    };

    // Coalesce bursts of mutations into a single recompute.
    let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRecompute = () => {
      if (recomputeTimer) return;
      recomputeTimer = setTimeout(() => {
        recomputeTimer = null;
        void emit();
      }, config.sse?.aggregateDebounceMs ?? 150);
    };

    const unwatch = registerAggregateWatcher(resourceName, (changed) => {
      if (affectsAggregate(changed)) scheduleRecompute();
    });

    const heartbeat = setInterval(() => {
      if (writer.closed) {
        clearInterval(heartbeat);
        return;
      }
      writer.write(`: ping ${Date.now()}\n\n`);
    }, sseConfig.heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (recomputeTimer) {
        clearTimeout(recomputeTimer);
        recomputeTimer = null;
      }
      unwatch();
      activeClients--;
      userSubscriptionCounts.set(
        userId,
        Math.max(0, (userSubscriptionCounts.get(userId) ?? 1) - 1)
      );
      ipSubscriptionCounts.set(
        clientIP,
        Math.max(0, (ipSubscriptionCounts.get(clientIP) ?? 1) - 1)
      );
      if (activeClients === 0) {
        stopEventPolling();
      }
      void unregisterHandler(handlerId);
    };

    writer.onClose(cleanup);

    const currentSeq = await changelog.getCurrentSequence();
    writer.write(`id: ${currentSeq}\nevent: connected\ndata: ${JSON.stringify({ seq: currentSeq })}\n\n`);
    await emit();

    return response;
  });

  router.get("/count", async (c) => {
    const filter = await applyFilters(c, "read");

    const [countData] = await db
      .select({ count: count() })
      .from(schema)
      .where(filter);

    return c.json({ count: countData?.count ?? 0 });
  });

  for (const [name, procedure] of Object.entries(procedures)) {
    router.post(`/rpc/${name}`, async (c) => {
      const ctx = createProcedureContext(c);
      const result = await executeProcedure(procedure, ctx, await readJsonBody(c));
      return c.json({ data: result });
    });
  }

  // Search endpoint and auto-indexing
  const searchEnabled = config.search?.enabled !== false && hasGlobalSearch();
  const autoIndexEnabled = searchEnabled && config.search?.autoIndex !== false;
  const searchIndexName = config.search?.indexName ?? resourceName;

  const outboxEnabled = !!config.search?.outbox && hasGlobalKV();
  if (outboxEnabled) {
    startSearchOutboxDrainer();
  }

  const onIndexError = config.search?.onIndexError;
  const runIndexOp = async (
    op: "index" | "delete",
    id: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    // One immediate retry, then surface the failure: structured-log it (so it's
    // observable/alertable instead of swallowed) and call the optional
    // onIndexError hook so apps can enqueue a re-index. The index can still lag
    // the DB on repeated failure — call recordExternalMutation / re-index to
    // reconcile.
    try {
      await fn();
    } catch {
      try {
        await fn();
      } catch (err) {
        getLogger().error("Search index operation failed", {
          resource: resourceName,
          index: searchIndexName,
          operation: op,
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (onIndexError) {
          try {
            await onIndexError({ operation: op, id, index: searchIndexName, error: err });
          } catch {
            // a failing error hook must not break the request
          }
        }
      }
    }
  };

  const indexDocument = async (id: string, document: Record<string, unknown>) => {
    if (!autoIndexEnabled) return;
    if (outboxEnabled) {
      await enqueueSearchOp({ index: searchIndexName, type: "index", docId: id, document });
      return;
    }
    await runIndexOp("index", id, () => getGlobalSearch().index(searchIndexName, id, document));
  };

  const deleteFromIndex = async (id: string) => {
    if (!autoIndexEnabled) return;
    if (outboxEnabled) {
      await enqueueSearchOp({ index: searchIndexName, type: "delete", docId: id });
      return;
    }
    await runIndexOp("delete", id, () => getGlobalSearch().delete(searchIndexName, id));
  };

  if (searchEnabled) {
    const searchConfig = config.search ?? {};
    const searchHandler = createSearchHandler(
      searchConfig,
      resourceName,
      idColumnName,
      {
        scopeResolver,
        getUser,
        filterer: filterer as unknown as SearchHandlerOptions["filterer"],
        // Runs a join scope as SQL to find which search-hit ids the user may read.
        enforceScopeIds: async (scopeExpr: string, ids: string[]) => {
          if (ids.length === 0) return new Set<string>();
          const idCol = schema[idColumnName as keyof typeof schema] as AnyColumn;
          const rows = (await db
            .select({ id: idCol })
            .from(schema)
            .where(
              and(
                filterer.convert(scopeExpr) as SQL<unknown>,
                inArray(idCol, ids as never[])
              )
            )) as Array<{ id: unknown }>;
          return new Set(rows.map((row) => String(row.id)));
        },
        maskItem: readableSet || computedFields ? (item) => maskReadable(item) : undefined,
      }
    );

    router.get("/search", searchHandler);
  }

  const relationsConfig = config.relations as RelationsConfig | undefined;
  const nestedWritesEnabled = config.nestedWrites === true && !!relationsConfig;

  router.post("/", async (c) => {
    await requireScope(c, "create");

    const ctx = createProcedureContext(c);
    const rawBody = (await readJsonBody(c)) as Record<string, unknown>;

    // Split out embedded relation objects when nested writes are enabled.
    const nestedEntries: { name: string; relation: any; value: unknown }[] = [];
    const mainBody: Record<string, unknown> = { ...rawBody };
    if (nestedWritesEnabled) {
      for (const [name, relation] of Object.entries(relationsConfig!)) {
        if (name in mainBody) {
          nestedEntries.push({ name, relation, value: mainBody[name] });
          delete mainBody[name];
        }
      }
    }

    let created: any;
    if (nestedEntries.length > 0) {
      // belongsTo parents first (to wire local FKs), then the main row, then
      // hasMany/hasOne children (wired to the new row's referenced key). Atomic
      // on engines with interactive transactions. On D1 these run sequentially
      // and are NOT atomic — each insert feeds the next via its returned id, so
      // they can't be expressed as a single db.batch (see the nested-writes docs).
      created = await txRunner.run(async (tx: DrizzleTransaction) => {
        for (const { relation, value } of nestedEntries) {
          if (
            relation.type === "belongsTo" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            const parent = (
              (await tx.insert(relation.schema).values(value as any).returning()) as any[]
            )[0];
            mainBody[relation.foreignKey.name] = parent[relation.references.name];
          }
        }

        let data = applyWritable(parseInsert(mainBody) as Record<string, unknown>) as typeof mainBody;
        data = await executeBeforeCreate(hooks, ctx, data as any) as typeof data;
        const row = ((await tx.insert(schema).values(data).returning()) as any[])[0];

        for (const { relation, value } of nestedEntries) {
          if (relation.type === "hasMany" || relation.type === "hasOne") {
            const parentRef = (row as Record<string, unknown>)[relation.references.name];
            const children = Array.isArray(value) ? value : value != null ? [value] : [];
            for (const child of children) {
              await tx
                .insert(relation.schema)
                .values({ ...(child as object), [relation.foreignKey.name]: parentRef } as any)
                .returning();
            }
          }
        }

        return row;
      });
    } else {
      let data = applyWritable(parseInsert(mainBody) as Record<string, unknown>) as any;
      data = await executeBeforeCreate(hooks, ctx, data);
      const insertResult = await db.insert(schema).values(data).returning();
      created = (insertResult as any[])[0];
    }

    const createdObj = created as Record<string, unknown>;

    await executeAfterCreate(hooks, ctx, created);

    recordCreate(resourceName, String(createdObj[idColumnName]), createdObj, getUser(c)?.id);
    await indexDocument(String(createdObj[idColumnName]), createdObj);

    const optimisticId = c.req.header("x-covara-optimistic-id");
    const optimisticIds = optimisticId
      ? new Map([[String(createdObj[idColumnName]), optimisticId]])
      : undefined;

    await pushInsertsToSubscriptions(
      resourceName,
      filterer as any,
      [createdObj],
      idColumnName,
      optimisticIds,
      subscriptionRelationLoader
    );

    const maskedCreated = maskReadable(created as Record<string, unknown>);
    const response = optimisticId
      ? { ...maskedCreated, _optimisticId: optimisticId }
      : maskedCreated;

    if (etagConfig) {
      setETagHeader(c, createdObj, etagConfig);
    }

    return c.json(response, 201);
  });

  router.get("/", async (c) => {
    const filter = await applyFilters(c, "read");
    const paginationParams = pagination.parseParams(c.req.query() as Record<string, unknown>);
    const selectFields = parseSelect(c.req.query("select"));
    const includeTotalCount = c.req.query("totalCount") === "true";
    const includeSpecs = resolveIncludeSpecs(c.req.query("include"));

    const orderByFields = parseOrderBy(paginationParams.orderBy);

    let query = db.select().from(schema);

    if (filter) {
      query = query.where(filter) as any;
    }

    if (paginationParams.cursor) {
      // Validate against the request's orderBy so a cursor replayed under a
      // different ordering (or a corrupted/expired cursor) is rejected with a
      // clear 4xx instead of silently restarting from the first page.
      const cursorData = pagination.validateAndDecodeCursor(
        paginationParams.cursor,
        paginationParams.orderBy
      );
      const cursorCondition = pagination.buildCursorCondition(
        cursorData,
        orderByFields
      );
      if (cursorCondition) {
        query = query.where(
          filter ? and(filter, cursorCondition) : cursorCondition
        ) as any;
      }
    }

    const orderByClauses = pagination.buildOrderBy(orderByFields);
    if (orderByClauses.length > 0) {
      query = (query as any).orderBy(...orderByClauses);
    }

    query = query.limit(paginationParams.limit + 1) as any;

    const items = await query;

    let totalCount: number | undefined;
    if (includeTotalCount) {
      const [countResult] = await db
        .select({ count: count() })
        .from(schema)
        .where(filter);
      totalCount = countResult?.count ?? 0;
    }

    const result = pagination.processResults(
      items as Record<string, unknown>[],
      paginationParams.limit,
      idColumnName,
      orderByFields,
      totalCount,
      paginationParams.orderBy
    );

    if (relationLoader && includeSpecs.length > 0) {
      result.items = await relationLoader.loadRelationsForItems(
        result.items,
        includeSpecs,
        idColumnName,
        0,
        { user: getUser(c), enforceScope: true }
      );
    }

    result.items = maskReadableList(result.items as Record<string, unknown>[]) as any;

    if (selectFields) {
      result.items = applyProjection(result.items, selectFields) as any;
    }

    return c.json(result);
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const filter = await applyFilters(c, "read", `${idColumnName}=="${id}"`);
    const selectFields = parseSelect(c.req.query("select"));
    const includeSpecs = resolveIncludeSpecs(c.req.query("include"));

    const selectResult = await db.select().from(schema).where(filter);
    const item = (selectResult as any[])[0];

    if (!item) {
      throw new NotFoundError(resourceName, id);
    }

    if (etagConfig) {
      const notModified = handleConditionalGet(
        c,
        c.req.header("if-none-match"),
        item as Record<string, unknown>,
        etagConfig
      );
      if (notModified) return notModified;
    }

    let result = item;

    if (relationLoader && includeSpecs.length > 0) {
      result = await relationLoader.loadRelationsForItem(
        result as Record<string, unknown>,
        includeSpecs,
        idColumnName,
        0,
        { user: getUser(c), enforceScope: true }
      );
    }

    result = maskReadable(result as Record<string, unknown>) as typeof item;

    if (selectFields) {
      result = applyProjection([result], selectFields)[0] as typeof item;
    }

    return c.json(result);
  });

  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const filter = await applyFilters(c, "update", `${idColumnName}=="${id}"`);

    const existingResult = await db.select().from(schema).where(filter);
    const existing = (existingResult as any[])[0];
    if (!existing) {
      throw new NotFoundError(resourceName, id);
    }

    if (etagConfig) {
      validateIfMatch(c.req.header("if-match"), existing, etagConfig);
    }

    const ctx = createProcedureContext(c);
    const data = applyWritable(parseInsert(await readJsonBody(c)) as Record<string, unknown>);

    let updateData = await executeBeforeUpdate(hooks, ctx, id, data as any);
    updateData = applyVersionBump(existing, updateData as Record<string, unknown>) as typeof updateData;

    const casPredicate = c.req.header("if-match") ? buildCasPredicate(existing) : undefined;
    const updateResult = await db
      .update(schema)
      .set(updateData as any)
      .where(casPredicate ? and(filter, casPredicate) : filter)
      .returning();
    const updated = (updateResult as any[])[0];
    if (!updated) {
      throw new PreconditionFailedError(generateETag(existing, etagConfig));
    }

    await executeAfterUpdate(hooks, ctx, updated);

    recordUpdate(resourceName, id, updated, existing, getUser(c)?.id);
    await indexDocument(id, updated);

    const previousMap = new Map<string, Record<string, unknown>>();
    previousMap.set(id, existing);
    await pushUpdatesToSubscriptions(
      resourceName,
      filterer as any,
      [updated],
      idColumnName,
      previousMap,
      subscriptionRelationLoader
    );

    if (etagConfig) {
      setETagHeader(c, updated, etagConfig);
    }

    return c.json(maskReadable(updated as Record<string, unknown>));
  });

  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const filter = await applyFilters(c, "update", `${idColumnName}=="${id}"`);

    const existingResult = await db.select().from(schema).where(filter);
    const existing = (existingResult as any[])[0];
    if (!existing) {
      throw new NotFoundError(resourceName, id);
    }

    if (etagConfig) {
      validateIfMatch(c.req.header("if-match"), existing, etagConfig);
    }

    const ctx = createProcedureContext(c);
    let data = applyWritable(parseUpdate(await readJsonBody(c)) as Record<string, unknown>) as any;

    data = await executeBeforeUpdate(hooks, ctx, id, data);
    data = applyVersionBump(existing, data as Record<string, unknown>) as typeof data;

    const casPredicate = c.req.header("if-match") ? buildCasPredicate(existing) : undefined;
    const updateResult = await db
      .update(schema)
      .set(data as any)
      .where(casPredicate ? and(filter, casPredicate) : filter)
      .returning();
    const updated = (updateResult as any[])[0];
    if (!updated) {
      throw new PreconditionFailedError(generateETag(existing, etagConfig));
    }

    await executeAfterUpdate(hooks, ctx, updated);

    recordUpdate(resourceName, id, updated, existing, getUser(c)?.id);
    await indexDocument(id, updated);

    const previousMap = new Map<string, Record<string, unknown>>();
    previousMap.set(id, existing);
    await pushUpdatesToSubscriptions(
      resourceName,
      filterer as any,
      [updated],
      idColumnName,
      previousMap,
      subscriptionRelationLoader
    );

    if (etagConfig) {
      setETagHeader(c, updated, etagConfig);
    }

    return c.json(maskReadable(updated as Record<string, unknown>));
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const filter = await applyFilters(c, "delete", `${idColumnName}=="${id}"`);

    const existingResult = await db.select().from(schema).where(filter);
    const existing = (existingResult as any[])[0];
    if (!existing) {
      throw new NotFoundError(resourceName, id);
    }

    if (etagConfig) {
      validateIfMatch(c.req.header("if-match"), existing, etagConfig);
    }

    const ctx = createProcedureContext(c);

    await executeBeforeDelete(hooks, ctx, id);

    const casPredicate = c.req.header("if-match") ? buildCasPredicate(existing) : undefined;
    const where = casPredicate ? and(filter, casPredicate) : filter;

    if (softDeleteConfig) {
      // Soft delete: mark the row deleted instead of removing it. Subscribers
      // still receive a "removed" event because the row leaves the (not-deleted)
      // read scope.
      const updated = await db
        .update(schema)
        .set({ [softDeleteConfig.field]: softDeleteValue() } as any)
        .where(where)
        .returning();
      if ((updated as any[]).length === 0) {
        if (casPredicate) {
          throw new PreconditionFailedError(generateETag(existing, etagConfig));
        }
        throw new NotFoundError(resourceName, id);
      }
    } else if (casPredicate) {
      const deleted = await db
        .delete(schema)
        .where(where)
        .returning();
      if ((deleted as any[]).length === 0) {
        throw new PreconditionFailedError(generateETag(existing, etagConfig));
      }
    } else {
      await db.delete(schema).where(filter);
    }

    await executeAfterDelete(hooks, ctx, existing);

    recordDelete(resourceName, id, existing, getUser(c)?.id);
    await deleteFromIndex(id);

    await pushDeletesToSubscriptions(resourceName, [id], [
      existing as Record<string, unknown>,
    ]);

    return c.body(null, 204);
  });

  return router;
};

export type { ResourceConfig, CustomOperator, ProcedureDefinition, LifecycleHooks };
