import { Table, getTableName, AnyColumn, SQL } from "drizzle-orm";
import { changelog, recordCreate, recordUpdate, recordDelete } from "./changelog";
import { ChangelogEntry, DrizzleDatabase } from "./types";
import { getGlobalKV, hasGlobalKV } from "../kv";
import { createHash } from "node:crypto";
import {
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  invalidateResourceSubscriptions,
} from "./subscription";
import { createResourceFilter, Filter } from "./filter";

export interface TableRegistration {
  table: Table<any>;
  id: AnyColumn;
  resourceName?: string;
}

export interface CacheConfig {
  enabled: boolean;
  ttl?: number;
  keyPrefix?: string;
  tables?: {
    [tableName: string]: {
      ttl?: number;
      enabled?: boolean;
    };
  };
}

export interface TrackMutationsConfig {
  onMutation?: (entry: ChangelogEntry) => void | Promise<void>;
  onRawSqlMutation?: (resourceName: string, type: "create" | "update" | "delete") => void | Promise<void>;
  skipTables?: string[];
  trackTransactions?: boolean;
  capturePreviousState?: boolean;
  cache?: CacheConfig;
  pushToSubscriptions?: boolean;
}

interface TableInfo {
  table: Table<any>;
  resourceName: string;
  idColumn: AnyColumn;
  idColumnName: string;
  filter: Filter;
}

interface TrackingContext {
  db: DrizzleDatabase;
  registry: Map<Table<any>, TableInfo>;
  registryByName: Map<string, TableInfo>;
  config: TrackMutationsConfig;
  trackingEnabled: boolean;
  pendingEvents?: Array<() => Promise<void>>;
}

async function runOrDefer(
  context: TrackingContext,
  thunk: () => Promise<void>
): Promise<void> {
  if (context.pendingEvents) {
    context.pendingEvents.push(thunk);
  } else {
    await thunk();
  }
}

export interface TrackedDatabase<TDb extends DrizzleDatabase> {
  _trackingContext: TrackingContext;
  _originalDb: TDb;
  withoutTracking<T>(fn: (db: TDb) => Promise<T>): Promise<T>;
}

type TrackedDb<TDb extends DrizzleDatabase> = TDb & TrackedDatabase<TDb>;

const CACHE_KEY_PREFIX = "covara:cache:";
const CACHE_KEYS_SET_PREFIX = "covara:cache:keys:";

function generateCacheKey(tableName: string, sql: string, params: unknown[], prefix: string): string {
  const hash = createHash("sha256")
    .update(sql)
    .update(JSON.stringify(params))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}${tableName}:${hash}`;
}

async function invalidateTableCache(tableName: string): Promise<void> {
  if (!hasGlobalKV()) return;

  const kv = getGlobalKV();
  const keysSetKey = `${CACHE_KEYS_SET_PREFIX}${tableName}`;
  const keys = await kv.smembers(keysSetKey);

  if (keys.length > 0) {
    await kv.del(...keys);
    await kv.del(keysSetKey);
  }
}

async function storeCacheKey(tableName: string, cacheKey: string): Promise<void> {
  if (!hasGlobalKV()) return;

  const kv = getGlobalKV();
  const keysSetKey = `${CACHE_KEYS_SET_PREFIX}${tableName}`;
  await kv.sadd(keysSetKey, cacheKey);
}

function detectMutation(sql: string): { type: "create" | "update" | "delete"; tableName: string } | null {
  const normalized = sql.trim();

  const insertMatch = normalized.match(/^INSERT\s+INTO\s+["'`]?(\w+)["'`]?/i);
  if (insertMatch) return { type: "create", tableName: insertMatch[1].toLowerCase() };

  const updateMatch = normalized.match(/^UPDATE\s+["'`]?(\w+)["'`]?/i);
  if (updateMatch) return { type: "update", tableName: updateMatch[1].toLowerCase() };

  const deleteMatch = normalized.match(/^DELETE\s+FROM\s+["'`]?(\w+)["'`]?/i);
  if (deleteMatch) return { type: "delete", tableName: deleteMatch[1].toLowerCase() };

  return null;
}

function wrapInsertBuilder(
  builder: any,
  tableInfo: TableInfo,
  context: TrackingContext
): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "values") {
        return (data: any) => {
          const base = target.values(data);
          return wrapInsertBase(base, tableInfo, context, data);
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

interface InsertState {
  hasReturning: boolean;
  hasConflictHandler: boolean;
}

function wrapInsertBase(
  base: any,
  tableInfo: TableInfo,
  context: TrackingContext,
  insertValues: any,
  state: InsertState = { hasReturning: false, hasConflictHandler: false }
): any {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "returning") {
        return (fields?: any) => {
          const result = fields ? target.returning(fields) : target.returning();
          return wrapInsertBase(result, tableInfo, context, insertValues, {
            ...state,
            hasReturning: true,
          });
        };
      }

      if (prop === "onConflictDoNothing" || prop === "onConflictDoUpdate") {
        return (...args: any[]) => {
          const result = target[prop](...args);
          return wrapInsertBase(result, tableInfo, context, insertValues, {
            ...state,
            hasConflictHandler: true,
          });
        };
      }

      if (prop === "then") {
        return async (resolve?: (value: any) => any, reject?: (error: any) => any) => {
          try {
            const result = await target;

            if (context.trackingEnabled) {
              const items = Array.isArray(result) ? result : (result ? [result] : []);

              await runOrDefer(context, async () => {
                // Only record mutations if we got results or if there's no conflict handler
                // With a conflict handler and no results, the insert was a no-op
                if (items.length === 0 && state.hasReturning === false && !state.hasConflictHandler) {
                  const insertArray = Array.isArray(insertValues) ? insertValues : [insertValues];
                  for (const item of insertArray) {
                    const id = item[tableInfo.idColumnName];
                    if (id !== undefined) {
                      const entry = await recordCreate(tableInfo.resourceName, String(id), item);
                      if (context.config.onMutation) {
                        await context.config.onMutation(entry);
                      }
                    }
                  }
                } else if (items.length > 0) {
                  for (const item of items) {
                    const id = String(item[tableInfo.idColumnName]);
                    const entry = await recordCreate(tableInfo.resourceName, id, item);
                    if (context.config.onMutation) {
                      await context.config.onMutation(entry);
                    }
                  }

                  if (context.config.pushToSubscriptions !== false) {
                    await pushInsertsToSubscriptions(
                      tableInfo.resourceName,
                      tableInfo.filter,
                      items,
                      tableInfo.idColumnName
                    );
                  }
                }

                if (context.config.cache?.enabled && items.length > 0) {
                  await invalidateTableCache(tableInfo.resourceName);
                }
              });
            }

            return resolve ? resolve(result) : result;
          } catch (error) {
            if (reject) return reject(error);
            throw error;
          }
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

function wrapUpdateBuilder(
  builder: any,
  tableInfo: TableInfo,
  context: TrackingContext
): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "set") {
        return (data: any) => {
          const base = target.set(data);
          return wrapUpdateBase(base, tableInfo, context, data);
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

interface UpdateState {
  whereClause?: SQL<unknown>;
  hasReturning: boolean;
}

function wrapUpdateBase(
  base: any,
  tableInfo: TableInfo,
  context: TrackingContext,
  updateValues: any,
  state: UpdateState = { hasReturning: false }
): any {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "where") {
        return (condition: SQL<unknown>) => {
          const result = target.where(condition);
          return wrapUpdateBase(result, tableInfo, context, updateValues, {
            ...state,
            whereClause: condition,
          });
        };
      }

      if (prop === "returning") {
        return (fields?: any) => {
          const result = fields ? target.returning(fields) : target.returning();
          return wrapUpdateBase(result, tableInfo, context, updateValues, {
            ...state,
            hasReturning: true,
          });
        };
      }

      if (prop === "then") {
        return async (resolve?: (value: any) => any, reject?: (error: any) => any) => {
          try {
            let previousItems: Record<string, unknown>[] = [];
            if (context.trackingEnabled && state.whereClause && context.config.capturePreviousState !== false) {
              previousItems = await context.db.select().from(tableInfo.table).where(state.whereClause);
            }
            const previousMap = new Map(
              previousItems.map((i) => [String(i[tableInfo.idColumnName]), i])
            );

            const result = await target;

            if (context.trackingEnabled) {
              const items = Array.isArray(result) ? result : (result ? [result] : []);

              await runOrDefer(context, async () => {
                for (const item of items) {
                  const id = String(item[tableInfo.idColumnName]);
                  const previousItem = previousMap.get(id);
                  const entry = await recordUpdate(tableInfo.resourceName, id, item, previousItem);
                  if (context.config.onMutation) {
                    await context.config.onMutation(entry);
                  }
                }

                if (context.config.pushToSubscriptions !== false && items.length > 0) {
                  await pushUpdatesToSubscriptions(
                    tableInfo.resourceName,
                    tableInfo.filter,
                    items,
                    tableInfo.idColumnName,
                    previousMap
                  );
                }

                if (context.config.cache?.enabled) {
                  await invalidateTableCache(tableInfo.resourceName);
                }
              });
            }

            return resolve ? resolve(result) : result;
          } catch (error) {
            if (reject) return reject(error);
            throw error;
          }
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

interface DeleteState {
  whereClause?: SQL<unknown>;
  hasReturning: boolean;
}

function wrapDeleteBuilder(
  builder: any,
  tableInfo: TableInfo,
  context: TrackingContext,
  state: DeleteState = { hasReturning: false }
): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "where") {
        return (condition: SQL<unknown>) => {
          const result = target.where(condition);
          return wrapDeleteBuilder(result, tableInfo, context, {
            ...state,
            whereClause: condition,
          });
        };
      }

      if (prop === "returning") {
        return (fields?: any) => {
          const result = fields ? target.returning(fields) : target.returning();
          return wrapDeleteBuilder(result, tableInfo, context, {
            ...state,
            hasReturning: true,
          });
        };
      }

      if (prop === "then") {
        return async (resolve?: (value: any) => any, reject?: (error: any) => any) => {
          try {
            let itemsToDelete: Record<string, unknown>[] = [];
            if (context.trackingEnabled && state.whereClause) {
              itemsToDelete = await context.db.select().from(tableInfo.table).where(state.whereClause);
            }

            const result = await target;

            if (context.trackingEnabled) {
              await runOrDefer(context, async () => {
                const deletedIds: string[] = [];

                for (const item of itemsToDelete) {
                  const id = String(item[tableInfo.idColumnName]);
                  deletedIds.push(id);
                  const entry = await recordDelete(tableInfo.resourceName, id, item);
                  if (context.config.onMutation) {
                    await context.config.onMutation(entry);
                  }
                }

                if (context.config.pushToSubscriptions !== false && deletedIds.length > 0) {
                  await pushDeletesToSubscriptions(
                    tableInfo.resourceName,
                    deletedIds,
                    itemsToDelete
                  );
                }

                if (context.config.cache?.enabled) {
                  await invalidateTableCache(tableInfo.resourceName);
                }
              });
            }

            return resolve ? resolve(result) : result;
          } catch (error) {
            if (reject) return reject(error);
            throw error;
          }
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

const JOIN_METHODS = ["leftJoin", "rightJoin", "innerJoin", "fullJoin"];
const CHAIN_METHODS = ["where", "orderBy", "limit", "offset", "groupBy", "having"];

function resolveResourceName(
  table: Table<any>,
  context: TrackingContext
): string {
  const name = getTableName(table);
  return context.registryByName.get(name)?.resourceName ?? name;
}

function wrapSelectBuilder(
  builder: any,
  context: TrackingContext,
  tableName: string | null = null,
  referencedTables: Set<string> = new Set()
): any {
  let currentTableName = tableName;

  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "from") {
        return (table: Table<any>) => {
          currentTableName = resolveResourceName(table, context);
          referencedTables.add(currentTableName);
          const result = target.from(table);
          return wrapSelectBuilder(result, context, currentTableName, referencedTables);
        };
      }

      if (prop === "then") {
        return async (resolve?: (value: any) => any, reject?: (error: any) => any) => {
          try {
            const cacheConfig = context.config.cache;
            const shouldCache = cacheConfig?.enabled && currentTableName && hasGlobalKV();

            if (shouldCache && currentTableName) {
              const tableCache = cacheConfig?.tables?.[currentTableName];
              if (tableCache?.enabled === false) {
                const result = await target;
                return resolve ? resolve(result) : result;
              }

              const kv = getGlobalKV();
              const keyPrefix = cacheConfig?.keyPrefix ?? CACHE_KEY_PREFIX;

              const queryObj = target.toSQL?.();
              if (queryObj) {
                const { sql, params } = queryObj;
                const cacheKey = generateCacheKey(currentTableName, sql, params, keyPrefix);

                const cached = await kv.get(cacheKey);
                if (cached) {
                  const result = JSON.parse(cached);
                  return resolve ? resolve(result) : result;
                }

                const result = await target;

                const ttl = tableCache?.ttl ?? cacheConfig?.ttl;
                if (ttl) {
                  await kv.set(cacheKey, JSON.stringify(result), { ex: Math.ceil(ttl / 1000) });
                } else {
                  await kv.set(cacheKey, JSON.stringify(result));
                }
                // Register the cache key under EVERY table the query touches
                // (including joined tables), so a mutation to any of them
                // invalidates this cached result — not just the FROM table.
                const tablesToTag = referencedTables.size > 0
                  ? referencedTables
                  : new Set([currentTableName]);
                for (const table of tablesToTag) {
                  await storeCacheKey(table, cacheKey);
                }

                return resolve ? resolve(result) : result;
              }
            }

            const result = await target;
            return resolve ? resolve(result) : result;
          } catch (error) {
            if (reject) return reject(error);
            throw error;
          }
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        const result = value.bind(target);
        if (JOIN_METHODS.includes(prop as string)) {
          return (...args: any[]) => {
            const joinedTable = args[0];
            if (joinedTable && typeof joinedTable === "object") {
              try {
                referencedTables.add(resolveResourceName(joinedTable as Table<any>, context));
              } catch {
                // not a table (e.g. a subquery) — nothing to tag
              }
            }
            return wrapSelectBuilder(result(...args), context, currentTableName, referencedTables);
          };
        }
        if (CHAIN_METHODS.includes(prop as string)) {
          return (...args: any[]) => wrapSelectBuilder(result(...args), context, currentTableName, referencedTables);
        }
        return result;
      }
      return value;
    },
  });
}

function extractSqlString(query: SQL | string): string {
  if (typeof query === "string") {
    return query;
  }

  const sqlObj = query as any;
  if (sqlObj.queryChunks && Array.isArray(sqlObj.queryChunks)) {
    return sqlObj.queryChunks
      .flatMap((chunk: any) => {
        if (typeof chunk === "string") return [chunk];
        if (chunk && Array.isArray(chunk.value)) return chunk.value;
        if (chunk && chunk.encoder) return ["?"];
        return [""];
      })
      .join("");
  }

  return "";
}

function recordDetectedMutation(
  sqlString: string,
  context: TrackingContext
): Promise<void> | void {
  const mutationInfo = detectMutation(sqlString);
  if (!mutationInfo) return;
  const tableInfo = context.registryByName.get(mutationInfo.tableName);
  if (!tableInfo) return;

  return runOrDefer(context, async () => {
    await changelog.append({
      resource: tableInfo.resourceName,
      type: mutationInfo.type,
      objectId: "*",
      object: undefined,
      previousObject: undefined,
      timestamp: Date.now(),
    });
    if (context.config.onRawSqlMutation) {
      await context.config.onRawSqlMutation(tableInfo.resourceName, mutationInfo.type);
    }
    if (context.config.cache?.enabled) {
      await invalidateTableCache(tableInfo.resourceName);
    }
    // Row-level details are unknown for raw SQL, so notify subscribers to
    // refetch rather than sending a precise added/changed/removed event.
    if (context.config.pushToSubscriptions !== false) {
      await invalidateResourceSubscriptions(tableInfo.resourceName, "raw-sql-mutation");
    }
  });
}

// Public entry point for writers OUTSIDE this process / outside trackMutations
// (cron jobs, other services, manual DB edits). Records a changelog entry,
// invalidates the query cache, and tells live subscribers to refetch. This is
// the portable alternative to database-specific CDC.
export async function recordExternalMutation(
  resource: string,
  type: "create" | "update" | "delete",
  options: { objectId?: string } = {}
): Promise<void> {
  await changelog.append({
    resource,
    type,
    objectId: options.objectId ?? "*",
    object: undefined,
    previousObject: undefined,
    timestamp: Date.now(),
  });
  await invalidateTableCache(resource);
  await invalidateResourceSubscriptions(resource, "external-mutation");
}

// drizzle's db.batch([...]) runs an array of query builders atomically without
// awaiting them individually, so the per-builder `.then()` tracking never
// fires. We extract each statement's SQL, detect the mutation, and record a
// coarse `invalidate` (objectId "*") — the same contract as raw SQL — so
// subscribers/caches stay correct even though we can't see individual rows.
function wrapBatch(
  target: any,
  context: TrackingContext
): (...args: any[]) => Promise<any> {
  return async (statements: any[]) => {
    const result = await target.batch(statements);

    if (context.trackingEnabled && Array.isArray(statements)) {
      for (const stmt of statements) {
        try {
          const compiled = stmt?.toSQL?.();
          const sqlString = compiled?.sql ?? "";
          if (sqlString) {
            await recordDetectedMutation(sqlString, context);
          }
        } catch {
          // a statement we can't introspect just isn't tracked
        }
      }
    }

    return result;
  };
}

function wrapRawSql(
  method: "run" | "execute",
  target: any,
  context: TrackingContext
): (...args: any[]) => Promise<any> {
  return async (query: SQL | string) => {
    const result = await target[method](query);

    if (context.trackingEnabled) {
      const sqlString = extractSqlString(query);
      const mutationInfo = detectMutation(sqlString);

      if (mutationInfo) {
        const tableInfo = context.registryByName.get(mutationInfo.tableName);

        if (tableInfo) {
          await runOrDefer(context, async () => {
            await changelog.append({
              resource: tableInfo.resourceName,
              type: mutationInfo.type,
              objectId: "*",
              object: undefined,
              previousObject: undefined,
              timestamp: Date.now(),
            });

            if (context.config.onRawSqlMutation) {
              await context.config.onRawSqlMutation(tableInfo.resourceName, mutationInfo.type);
            }

            if (context.config.cache?.enabled) {
              await invalidateTableCache(tableInfo.resourceName);
            }
          });
        }
      }
    }

    return result;
  };
}

function wrapTransaction(
  tx: any,
  registry: Map<Table<any>, TableInfo>,
  registryByName: Map<string, TableInfo>,
  config: TrackMutationsConfig,
  pendingEvents: Array<() => Promise<void>>
): any {
  const txContext: TrackingContext = {
    db: tx,
    registry,
    registryByName,
    config,
    trackingEnabled: true,
    pendingEvents,
  };

  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "transaction" && config.trackTransactions !== false) {
        return async <T>(fn: (nestedTx: any) => Promise<T>, txConfig?: any): Promise<T> => {
          return target.transaction(async (nestedTx: any) => {
            const wrappedNested = wrapTransaction(nestedTx, registry, registryByName, config, pendingEvents);
            return fn(wrappedNested);
          }, txConfig);
        };
      }
      if (prop === "insert") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.insert(table);
          }
          return wrapInsertBuilder(target.insert(table), tableInfo, txContext);
        };
      }

      if (prop === "update") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.update(table);
          }
          return wrapUpdateBuilder(target.update(table), tableInfo, txContext);
        };
      }

      if (prop === "delete") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.delete(table);
          }
          return wrapDeleteBuilder(target.delete(table), tableInfo, txContext);
        };
      }

      if (prop === "select") {
        return (fields?: any) => {
          const selectBuilder = fields ? target.select(fields) : target.select();
          if (config.cache?.enabled) {
            return wrapSelectBuilder(selectBuilder, txContext);
          }
          return selectBuilder;
        };
      }

      if (prop === "run" || prop === "execute") {
        return wrapRawSql(prop, target, txContext);
      }

      if (prop === "batch") {
        return wrapBatch(target, txContext);
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

export function isTrackedDb(db: unknown): db is TrackedDb<DrizzleDatabase> {
  if (db === null || typeof db !== "object") {
    return false;
  }
  // Access properties directly since proxies may not have `has` trap
  const maybeTracked = db as Record<string, unknown>;
  return (
    maybeTracked._trackingContext !== undefined &&
    maybeTracked._originalDb !== undefined
  );
}

export function trackMutations<TDb extends DrizzleDatabase>(
  db: TDb,
  tables: Record<string, TableRegistration>,
  config: TrackMutationsConfig = {}
): TrackedDb<TDb> {
  const registry = new Map<Table<any>, TableInfo>();
  const registryByName = new Map<string, TableInfo>();

  for (const registration of Object.values(tables)) {
    const tableName = getTableName(registration.table);
    const resourceName = registration.resourceName ?? tableName;
    const filter = createResourceFilter(registration.table, {});

    const tableInfo: TableInfo = {
      table: registration.table,
      resourceName,
      idColumn: registration.id,
      idColumnName: registration.id.name,
      filter,
    };

    registry.set(registration.table, tableInfo);
    registryByName.set(tableName, tableInfo);
    registryByName.set(resourceName, tableInfo);
  }

  const context: TrackingContext = {
    db,
    registry,
    registryByName,
    config,
    trackingEnabled: true,
  };

  const proxy = new Proxy(db as any, {
    get(target, prop) {
      if (prop === "_trackingContext") {
        return context;
      }

      if (prop === "_originalDb") {
        return db;
      }

      if (prop === "withoutTracking") {
        return async <T>(fn: (db: TDb) => Promise<T>): Promise<T> => {
          const prevEnabled = context.trackingEnabled;
          context.trackingEnabled = false;
          try {
            return await fn(db);
          } finally {
            context.trackingEnabled = prevEnabled;
          }
        };
      }

      if (prop === "insert") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.insert(table);
          }
          return wrapInsertBuilder(target.insert(table), tableInfo, context);
        };
      }

      if (prop === "update") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.update(table);
          }
          return wrapUpdateBuilder(target.update(table), tableInfo, context);
        };
      }

      if (prop === "delete") {
        return (table: Table<any>) => {
          const tableInfo = registry.get(table);
          if (!tableInfo || config.skipTables?.includes(tableInfo.resourceName)) {
            return target.delete(table);
          }
          return wrapDeleteBuilder(target.delete(table), tableInfo, context);
        };
      }

      if (prop === "select") {
        return (fields?: any) => {
          const selectBuilder = fields ? target.select(fields) : target.select();
          if (config.cache?.enabled) {
            return wrapSelectBuilder(selectBuilder, context);
          }
          return selectBuilder;
        };
      }

      if (prop === "run" || prop === "execute") {
        return wrapRawSql(prop, target, context);
      }

      if (prop === "batch") {
        return wrapBatch(target, context);
      }

      if (prop === "transaction" && config.trackTransactions !== false) {
        return async <T>(fn: (tx: any) => Promise<T>, txConfig?: any): Promise<T> => {
          const pendingEvents: Array<() => Promise<void>> = [];
          const result = await target.transaction(async (tx: any) => {
            const wrappedTx = wrapTransaction(tx, registry, registryByName, config, pendingEvents);
            return fn(wrappedTx);
          }, txConfig);

          // The transaction committed successfully — only now emit changelog
          // entries, subscription pushes, and cache invalidations. If the
          // transaction had rolled back, `target.transaction` would have thrown
          // and these buffered side effects would be discarded.
          for (const emit of pendingEvents) {
            await emit();
          }

          return result;
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });

  return proxy as TrackedDb<TDb>;
}

export async function invalidateCache(resourceName: string): Promise<void> {
  await invalidateTableCache(resourceName);
}

export async function invalidateAllCache(): Promise<void> {
  if (!hasGlobalKV()) return;

  const kv = getGlobalKV();
  const keys = await kv.keys(`${CACHE_KEYS_SET_PREFIX}*`);

  for (const keysSetKey of keys) {
    const cacheKeys = await kv.smembers(keysSetKey);
    if (cacheKeys.length > 0) {
      await kv.del(...cacheKeys);
    }
    await kv.del(keysSetKey);
  }
}
