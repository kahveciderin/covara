import {
  Table,
  TableConfig,
  SQL,
  sql,
  asc,
  desc,
  gt,
  lt,
  eq,
  or,
  and,
  isNull,
  isNotNull,
  AnyColumn,
  getTableColumns,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import { PaginationParams, PaginatedResult } from "./types";
import { ValidationError, CursorInvalidError, CursorExpiredError } from "./error";

export const CURSOR_VERSION = 1;

export interface CursorData {
  v: unknown;
  id: string;
  _ver: number;
  _orderByHash: string;
  _ts: number;
}

export interface LegacyCursorData {
  v: unknown;
  id: string;
}

export interface PaginationConfig {
  defaultLimit: number;
  maxLimit: number;
  cursorMaxAgeMs?: number;
  nullsPosition?: "first" | "last";
}

const DEFAULT_CONFIG: PaginationConfig = {
  defaultLimit: 20,
  maxLimit: 100,
  nullsPosition: "last",
};

export const hashOrderBy = (orderBy: string | undefined): string => {
  if (!orderBy) return "default";
  return createHash("sha256").update(orderBy).digest("hex").slice(0, 8);
};

export const encodeCursor = (
  data: Omit<CursorData, "_ver" | "_orderByHash" | "_ts">,
  orderBy?: string
): string => {
  const fullData: CursorData = {
    ...data,
    _ver: CURSOR_VERSION,
    _orderByHash: hashOrderBy(orderBy),
    _ts: Date.now(),
  };
  return Buffer.from(JSON.stringify(fullData)).toString("base64url");
};

export type CursorDecodeResult =
  | { success: true; data: CursorData }
  | { success: false; error: "malformed" | "version_mismatch" | "orderby_mismatch" | "expired" };

export const decodeCursor = (
  cursor: string,
  expectedOrderBy?: string,
  config?: PaginationConfig
): CursorDecodeResult => {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const data = JSON.parse(decoded);

    if (typeof data !== "object" || data === null) {
      return { success: false, error: "malformed" };
    }

    if (!("v" in data) || !("id" in data)) {
      return { success: false, error: "malformed" };
    }

    if ("_ver" in data) {
      if (data._ver !== CURSOR_VERSION) {
        return { success: false, error: "version_mismatch" };
      }

      const expectedHash = hashOrderBy(expectedOrderBy);
      if (data._orderByHash && data._orderByHash !== expectedHash) {
        return { success: false, error: "orderby_mismatch" };
      }

      if (config?.cursorMaxAgeMs && data._ts) {
        const age = Date.now() - data._ts;
        if (age > config.cursorMaxAgeMs) {
          return { success: false, error: "expired" };
        }
      }

      return { success: true, data: data as CursorData };
    }

    const legacyData = data as LegacyCursorData;
    const upgradedData: CursorData = {
      v: legacyData.v,
      id: legacyData.id,
      _ver: CURSOR_VERSION,
      _orderByHash: hashOrderBy(expectedOrderBy),
      _ts: Date.now(),
    };

    return { success: true, data: upgradedData };
  } catch {
    return { success: false, error: "malformed" };
  }
};

export const decodeCursorLegacy = (cursor: string): CursorData | null => {
  const result = decodeCursor(cursor);
  if (result.success) {
    return result.data;
  }
  return null;
};

export interface OrderByField {
  field: string;
  direction: "asc" | "desc";
}

// Supports two direction syntaxes, which may be mixed across fields:
//   "name:desc"  — explicit suffix
//   "-name"      — leading "-" for descending (JSON:API style); "+name" or bare = ascending
// Using both on the same field (e.g. "-name:desc") is a conflict and errors.
export const parseOrderBy = (orderBy?: string): OrderByField[] => {
  if (!orderBy) return [];

  return orderBy
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [rawField, dirSuffix] = part.split(":");
      let field = rawField.trim();

      let prefixDir: "asc" | "desc" | undefined;
      if (field.startsWith("-")) {
        prefixDir = "desc";
        field = field.slice(1).trim();
      } else if (field.startsWith("+")) {
        prefixDir = "asc";
        field = field.slice(1).trim();
      }

      const suffix = dirSuffix?.trim().toLowerCase();
      let suffixDir: "asc" | "desc" | undefined;
      if (suffix === "asc" || suffix === "desc") {
        suffixDir = suffix;
      } else if (suffix !== undefined && suffix !== "") {
        throw new ValidationError(
          `Invalid sort direction "${dirSuffix}" for "${field}" (expected "asc" or "desc")`
        );
      }

      if (prefixDir && suffixDir) {
        throw new ValidationError(
          `Conflicting sort direction for "${field}": use either "${prefixDir === "desc" ? "-" : "+"}${field}" or "${field}:${suffixDir}", not both`
        );
      }

      return { field, direction: prefixDir ?? suffixDir ?? "asc" };
    });
};

export const buildOrderByClause = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  orderByFields: OrderByField[]
): SQL[] => {
  const columns = getTableColumns(schema);
  const clauses: SQL[] = [];

  for (const { field, direction } of orderByFields) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid orderBy field: ${field}`);
    }
    clauses.push(direction === "desc" ? desc(column) : asc(column));
  }

  clauses.push(asc(idColumn));

  return clauses;
};

const buildNullAwareEquality = (
  column: AnyColumn,
  value: unknown
): SQL => {
  if (value === null || value === undefined) {
    return isNull(column);
  }
  return eq(column, value);
};

export const buildCursorCondition = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  cursor: CursorData,
  orderByFields: OrderByField[],
  direction: "forward" | "backward" = "forward",
  nullsPosition: "first" | "last" = "last"
): SQL | undefined => {
  const columns = getTableColumns(schema);

  if (orderByFields.length === 0) {
    const compare = direction === "forward" ? gt : lt;
    return compare(idColumn, cursor.id);
  }

  const conditions: SQL[] = [];
  const cursorValues = cursor.v as Record<string, unknown>;

  for (let i = 0; i < orderByFields.length; i++) {
    const { field, direction: fieldDir } = orderByFields[i]!;
    const column = columns[field];
    if (!column) continue;

    const cursorValue = cursorValues[field];
    const equalParts: SQL[] = [];

    for (let j = 0; j < i; j++) {
      const prevField = orderByFields[j]!.field;
      const prevColumn = columns[prevField];
      if (prevColumn) {
        equalParts.push(buildNullAwareEquality(prevColumn, cursorValues[prevField]));
      }
    }

    const isDesc = fieldDir === "desc";
    const isBackward = direction === "backward";
    const useGreaterThan = isDesc !== isBackward;
    const compare = useGreaterThan ? lt : gt;

    const effectiveNullsPosition =
      isDesc
        ? (nullsPosition === "last" ? "first" : "last")
        : nullsPosition;

    const cursorIsNull = cursorValue === null || cursorValue === undefined;

    let comparison: SQL;

    if (cursorIsNull) {
      if (effectiveNullsPosition === "last") {
        comparison = sql`0 = 1`;
      } else {
        if (useGreaterThan) {
          comparison = sql`0 = 1`;
        } else {
          comparison = isNotNull(column);
        }
      }
    } else {
      if (effectiveNullsPosition === "last") {
        if (useGreaterThan) {
          comparison = and(
            isNotNull(column),
            compare(column, cursorValue)
          )!;
        } else {
          comparison = or(
            compare(column, cursorValue),
            isNull(column)
          )!;
        }
      } else {
        if (useGreaterThan) {
          comparison = or(
            compare(column, cursorValue),
            isNull(column)
          )!;
        } else {
          comparison = and(
            isNotNull(column),
            compare(column, cursorValue)
          )!;
        }
      }
    }

    if (equalParts.length > 0) {
      conditions.push(and(...equalParts, comparison)!);
    } else {
      conditions.push(comparison);
    }
  }

  const allEqual: SQL[] = [];
  for (const { field } of orderByFields) {
    const column = columns[field];
    if (column) {
      allEqual.push(buildNullAwareEquality(column, cursorValues[field]));
    }
  }

  const idCompare = direction === "forward" ? gt : lt;
  conditions.push(and(...allEqual, idCompare(idColumn, cursor.id))!);

  return or(...conditions);
};

export const extractCursorValues = <T extends Record<string, unknown>>(
  item: T,
  idColumn: string,
  orderByFields: OrderByField[]
): Omit<CursorData, "_ver" | "_orderByHash" | "_ts"> => {
  const values: Record<string, unknown> = {};

  for (const { field } of orderByFields) {
    values[field] = item[field];
  }

  return {
    v: orderByFields.length > 0 ? values : item[idColumn],
    id: String(item[idColumn]),
  };
};

export const processPaginatedResults = <T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  idColumn: string,
  orderByFields: OrderByField[],
  totalCount?: number,
  orderBy?: string
): PaginatedResult<T> => {
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, limit) : items;

  let nextCursor: string | null = null;
  if (hasMore && resultItems.length > 0) {
    const lastItem = resultItems[resultItems.length - 1]!;
    nextCursor = encodeCursor(
      extractCursorValues(lastItem, idColumn, orderByFields),
      orderBy
    );
  }

  return {
    items: resultItems,
    nextCursor,
    hasMore,
    totalCount,
  };
};

export const normalizePaginationParams = (
  params: Partial<PaginationParams>,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationParams => {
  let limit = params.limit ?? config.defaultLimit;

  if (limit < 1) {
    limit = 1;
  } else if (limit > config.maxLimit) {
    limit = config.maxLimit;
  }

  return {
    cursor: params.cursor,
    limit,
    orderBy: params.orderBy,
    orderDirection: params.orderDirection ?? "asc",
  };
};

export const parsePaginationFromQuery = (
  query: Record<string, unknown>,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationParams => {
  const cursor =
    typeof query.cursor === "string" ? query.cursor : undefined;
  const limit =
    typeof query.limit === "string"
      ? parseInt(query.limit, 10)
      : typeof query.limit === "number"
        ? query.limit
        : config.defaultLimit;
  const orderBy =
    typeof query.orderBy === "string" ? query.orderBy : undefined;
  const orderDirection =
    query.orderDirection === "desc" ? "desc" : "asc";

  return normalizePaginationParams(
    { cursor, limit, orderBy, orderDirection },
    config
  );
};

export const validateAndDecodeCursor = (
  cursor: string,
  expectedOrderBy?: string,
  config?: PaginationConfig
): CursorData => {
  const result = decodeCursor(cursor, expectedOrderBy, config);

  if (!result.success) {
    switch (result.error) {
      case "malformed":
        throw new CursorInvalidError("malformed");
      case "version_mismatch":
        throw new CursorInvalidError("version_mismatch");
      case "orderby_mismatch":
        throw new CursorInvalidError("orderby_mismatch", {
          suggestion: "The orderBy parameter must match the original query",
        });
      case "expired":
        throw new CursorExpiredError({
          suggestion: "Please start from the beginning of the list",
        });
    }
  }

  return result.data;
};

export const createPagination = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  config: Partial<PaginationConfig> = {}
) => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    config: mergedConfig,

    parseParams: (query: Record<string, unknown>) =>
      parsePaginationFromQuery(query, mergedConfig),

    buildOrderBy: (orderByFields: OrderByField[]) =>
      buildOrderByClause(schema, idColumn, orderByFields),

    buildCursorCondition: (
      cursor: CursorData,
      orderByFields: OrderByField[],
      direction: "forward" | "backward" = "forward"
    ) =>
      buildCursorCondition(
        schema,
        idColumn,
        cursor,
        orderByFields,
        direction,
        mergedConfig.nullsPosition
      ),

    processResults: <T extends Record<string, unknown>>(
      items: T[],
      limit: number,
      idColumnName: string,
      orderByFields: OrderByField[],
      totalCount?: number,
      orderBy?: string
    ) =>
      processPaginatedResults(
        items,
        limit,
        idColumnName,
        orderByFields,
        totalCount,
        orderBy
      ),

    encodeCursor: (
      data: Omit<CursorData, "_ver" | "_orderByHash" | "_ts">,
      orderBy?: string
    ) => encodeCursor(data, orderBy),

    decodeCursor: (cursor: string, orderBy?: string) =>
      decodeCursor(cursor, orderBy, mergedConfig),

    validateAndDecodeCursor: (cursor: string, orderBy?: string) =>
      validateAndDecodeCursor(cursor, orderBy, mergedConfig),

    parseOrderBy,

    hashOrderBy,
  };
};

export { DEFAULT_CONFIG as defaultPaginationConfig };
