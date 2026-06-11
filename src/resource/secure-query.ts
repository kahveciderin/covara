import {
  Table,
  TableConfig,
  SQL,
  and,
  count,
  getTableColumns,
  InferSelectModel,
} from "drizzle-orm";
import { Operation, ScopeResolver, combineScopes } from "@/auth/scope";
import { Filter } from "./filter";
import {
  DrizzleDatabase,
  DrizzleTransaction,
  UserContext,
  AggregationParams,
} from "./types";
import {
  buildAggregationSelections,
  transformAggregationResults,
  ParsedAggregationParams,
} from "./query";

export interface SecureQueryContext {
  user: UserContext | null;
  bypassReason?: string;
}

export interface SecureQueryResult<T> {
  items: T[];
  totalCount?: number;
}

export interface SecureCountResult {
  count: number;
}

export interface SecureAggregateResult {
  groups: Array<{
    key: Record<string, unknown> | null;
    count?: number;
    sum?: Record<string, number>;
    avg?: Record<string, number>;
    min?: Record<string, number | string>;
    max?: Record<string, number | string>;
  }>;
}

export interface AdminContext {
  reason: string;
  timestamp: Date;
  userId?: string;
}

const adminAuditLog: AdminContext[] = [];

export const getAdminAuditLog = (): AdminContext[] => [...adminAuditLog];

export const clearAdminAuditLog = (): void => {
  adminAuditLog.length = 0;
};

export interface SecureQueryBuilder<TConfig extends TableConfig> {
  select(additionalFilter?: string): Promise<SQL<unknown> | undefined>;

  selectWithScope(
    operation: Operation,
    additionalFilter?: string
  ): Promise<SQL<unknown> | undefined>;

  executeSelect<T extends Record<string, unknown>>(
    additionalFilter?: string,
    options?: {
      limit?: number;
      offset?: number;
      orderBy?: SQL[];
      cursorCondition?: SQL;
    }
  ): Promise<T[]>;

  executeCount(additionalFilter?: string): Promise<number>;

  executeAggregate(
    params: AggregationParams,
    additionalFilter?: string
  ): Promise<SecureAggregateResult>;

  asAdmin(reason: string): SecureQueryBuilder<TConfig>;
  
  withBypassScope(reason: string): SecureQueryBuilder<TConfig>;
}

export const createSecureQueryBuilder = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  db: DrizzleDatabase,
  scopeResolver: ScopeResolver,
  filterer: Filter,
  ctx: SecureQueryContext,
  defaultOperation: Operation = "read"
): SecureQueryBuilder<TConfig> => {
  let isAdmin = false;
  let bypassReason: string | undefined;

  const logAdminAccess = (reason: string) => {
    const entry: AdminContext = {
      reason,
      timestamp: new Date(),
      userId: ctx.user?.id,
    };
    adminAuditLog.push(entry);
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "admin_scope_bypass",
        ...entry,
      })
    );
  };

  const buildFilter = async (
    operation: Operation,
    additionalFilter?: string
  ): Promise<SQL<unknown> | undefined> => {
    if (isAdmin || bypassReason) {
      logAdminAccess(bypassReason || "Admin query");
      const filterQuery = additionalFilter ?? "";
      if (!filterQuery || filterQuery.trim() === "") {
        return undefined;
      }
      return filterer.convert(filterQuery) as SQL<unknown>;
    }

    const scope = await scopeResolver.resolve(operation, ctx.user);
    const filterQuery = additionalFilter ?? "";
    const combinedFilter = combineScopes(scope, filterQuery);

    if (combinedFilter === "" || combinedFilter === "*") {
      return filterQuery
        ? (filterer.convert(filterQuery) as SQL<unknown>)
        : undefined;
    }

    return filterer.convert(combinedFilter) as SQL<unknown>;
  };

  const builder: SecureQueryBuilder<TConfig> = {
    async select(additionalFilter?: string): Promise<SQL<unknown> | undefined> {
      return buildFilter(defaultOperation, additionalFilter);
    },

    async selectWithScope(
      operation: Operation,
      additionalFilter?: string
    ): Promise<SQL<unknown> | undefined> {
      return buildFilter(operation, additionalFilter);
    },

    async executeSelect<T extends Record<string, unknown>>(
      additionalFilter?: string,
      options?: {
        limit?: number;
        offset?: number;
        orderBy?: SQL[];
        cursorCondition?: SQL;
      }
    ): Promise<T[]> {
      const filter = await buildFilter(defaultOperation, additionalFilter);

      let query = db.select().from(schema);

      const conditions: SQL[] = [];
      if (filter) conditions.push(filter);
      if (options?.cursorCondition) conditions.push(options.cursorCondition);

      if (conditions.length > 0) {
        query = query.where(
          conditions.length === 1 ? conditions[0] : and(...conditions)
        );
      }

      if (options?.orderBy && options.orderBy.length > 0) {
        query = query.orderBy(...options.orderBy);
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.offset(options.offset);
      }

      return query as unknown as Promise<T[]>;
    },

    async executeCount(additionalFilter?: string): Promise<number> {
      const filter = await buildFilter(defaultOperation, additionalFilter);

      const [result] = await db
        .select({ count: count() })
        .from(schema)
        .where(filter);

      return result?.count ?? 0;
    },

    async executeAggregate(
      params: AggregationParams,
      additionalFilter?: string
    ): Promise<SecureAggregateResult> {
      const filter = await buildFilter(defaultOperation, additionalFilter);

      // Convert to ParsedAggregationParams with defaults
      const parsedParams: ParsedAggregationParams = {
        groupBy: params.groupBy ?? [],
        sum: params.sum ?? [],
        avg: params.avg ?? [],
        min: params.min ?? [],
        max: params.max ?? [],
        count: params.count ?? false,
      };

      const { groupByColumns, aggregateColumns } = buildAggregationSelections(
        schema,
        parsedParams
      );

      const columns = getTableColumns(schema);
      const selectObj: Record<string, unknown> = {
        ...groupByColumns,
        ...aggregateColumns,
      };

      let query = db.select(selectObj).from(schema);

      if (filter) {
        query = query.where(filter);
      }

      if (parsedParams.groupBy.length > 0) {
        const groupByCols = parsedParams.groupBy
          .map((f) => columns[f])
          .filter(Boolean);
        query = query.groupBy(...groupByCols);
      }

      const results = await query;
      return transformAggregationResults(
        results as Record<string, unknown>[],
        parsedParams
      );
    },

    asAdmin(reason: string): SecureQueryBuilder<TConfig> {
      isAdmin = true;
      bypassReason = reason;
      return builder;
    },

    withBypassScope(reason: string): SecureQueryBuilder<TConfig> {
      bypassReason = reason;
      return builder;
    },
  };

  return builder;
};

export interface SecureMutationBuilder<TConfig extends TableConfig> {
  insert(
    data: Record<string, unknown> | Record<string, unknown>[]
  ): Promise<InferSelectModel<Table<TConfig>>[]>;

  update(
    filter: SQL<unknown> | undefined,
    data: Record<string, unknown>
  ): Promise<InferSelectModel<Table<TConfig>>[]>;

  delete(filter: SQL<unknown> | undefined): Promise<void>;

  asAdmin(reason: string): SecureMutationBuilder<TConfig>;
}

export const createSecureMutationBuilder = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  db: DrizzleDatabase | DrizzleTransaction,
  scopeResolver: ScopeResolver,
  filterer: Filter,
  ctx: SecureQueryContext
): SecureMutationBuilder<TConfig> => {
  let bypassReason: string | undefined;

  const logAdminMutation = (reason: string, operation: string) => {
    const entry: AdminContext = {
      reason: `${operation}: ${reason}`,
      timestamp: new Date(),
      userId: ctx.user?.id,
    };
    adminAuditLog.push(entry);
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "admin_mutation_bypass",
        operation,
        ...entry,
      })
    );
  };

  const builder: SecureMutationBuilder<TConfig> = {
    async insert(
      data: Record<string, unknown> | Record<string, unknown>[]
    ): Promise<InferSelectModel<Table<TConfig>>[]> {
      if (bypassReason) {
        logAdminMutation(bypassReason, "insert");
      } else {
        await scopeResolver.requirePermission("create", ctx.user);
      }

      const items = Array.isArray(data) ? data : [data];
      const result = await db.insert(schema).values(items).returning();
      return result as InferSelectModel<Table<TConfig>>[];
    },

    async update(
      filter: SQL<unknown> | undefined,
      data: Record<string, unknown>
    ): Promise<InferSelectModel<Table<TConfig>>[]> {
      if (bypassReason) {
        logAdminMutation(bypassReason, "update");
      }

      const result = await db
        .update(schema)
        .set(data)
        .where(filter)
        .returning();

      return result as InferSelectModel<Table<TConfig>>[];
    },

    async delete(filter: SQL<unknown> | undefined): Promise<void> {
      if (bypassReason) {
        logAdminMutation(bypassReason, "delete");
      }

      await db.delete(schema).where(filter);
    },

    asAdmin(reason: string): SecureMutationBuilder<TConfig> {
      bypassReason = reason;
      return builder;
    },
  };

  return builder;
};
