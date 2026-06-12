import {
  Table,
  TableConfig,
  SQL,
  sql,
  and,
  count,
  sum,
  avg,
  min,
  max,
  getTableColumns,
  AnyColumn,
} from "drizzle-orm";
import { AggregationResult } from "./types";
import { ValidationError } from "./error";

export const parseSelect = (select?: string): string[] | undefined => {
  if (!select) return undefined;
  return select
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
};

export const validateFields = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  fields: string[]
): void => {
  const columns = getTableColumns(schema);
  const validFields = Object.keys(columns);

  for (const field of fields) {
    if (!validFields.includes(field)) {
      throw new ValidationError(`Invalid field: ${field}`, {
        field,
        validFields,
      });
    }
  }
};

export const buildProjection = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  fields?: string[]
): Record<string, AnyColumn> | undefined => {
  if (!fields || fields.length === 0) return undefined;

  const columns = getTableColumns(schema);
  const projection: Record<string, AnyColumn> = {};

  for (const field of fields) {
    const column = columns[field];
    if (column) {
      projection[field] = column;
    }
  }

  return Object.keys(projection).length > 0 ? projection : undefined;
};

export const applyProjection = <T extends Record<string, unknown>>(
  items: T[],
  fields?: string[]
): Partial<T>[] => {
  if (!fields || fields.length === 0) return items;

  return items.map((item) => {
    const projected: Partial<T> = {};
    for (const field of fields) {
      if (field in item) {
        projected[field as keyof T] = item[field as keyof T];
      }
    }
    return projected;
  });
};

export interface ParsedAggregationParams {
  groupBy: string[];
  sum: string[];
  avg: string[];
  min: string[];
  max: string[];
  count: boolean;
  having?: string;
}

export const parseAggregationParams = (
  query: Record<string, unknown>
): ParsedAggregationParams => {
  const parseStringArray = (value: unknown): string[] => {
    if (!value) return [];
    if (typeof value === "string") {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (Array.isArray(value)) {
      return value.filter((v) => typeof v === "string") as string[];
    }
    return [];
  };

  return {
    groupBy: parseStringArray(query.groupBy),
    sum: parseStringArray(query.sum),
    avg: parseStringArray(query.avg),
    min: parseStringArray(query.min),
    max: parseStringArray(query.max),
    count: query.count === "true" || query.count === true,
    having: typeof query.having === "string" ? query.having : undefined,
  };
};

const HAVING_OPERATORS: Record<string, string> = {
  "==": "=",
  "!=": "<>",
  ">=": ">=",
  "<=": "<=",
  ">": ">",
  "<": "<",
};

// Builds a SQL HAVING condition over aggregate output aliases (count, sum_x,
// avg_x, min_x, max_x) or group-by columns. Syntax: comparisons joined by `;`
// (AND), e.g. `count>=5;sum_amount>100`. Reuses the same aggregate SQL
// expressions so it is portable across SQLite and Postgres.
export const buildHavingCondition = (
  havingExpr: string,
  aggregateColumns: Record<string, SQL>,
  groupByColumns: Record<string, AnyColumn>
): SQL | undefined => {
  const terms = havingExpr
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return undefined;

  const conditions: SQL[] = [];
  for (const term of terms) {
    const match = term.match(/^([A-Za-z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!match) {
      throw new ValidationError(`Invalid having expression: ${term}`);
    }
    const [, alias, op, rawValue] = match;
    const expr = aggregateColumns[alias] ?? groupByColumns[alias];
    if (!expr) {
      throw new ValidationError(`Unknown having field: ${alias}`);
    }
    const sqlOp = HAVING_OPERATORS[op];
    const numeric = Number(rawValue);
    const value: unknown = rawValue !== "" && !Number.isNaN(numeric) ? numeric : rawValue;
    conditions.push(sql`${expr} ${sql.raw(sqlOp)} ${value}`);
  }

  return conditions.length === 1 ? conditions[0] : and(...conditions);
};

export interface AggregationSelections {
  groupByColumns: Record<string, AnyColumn>;
  aggregateColumns: Record<string, SQL>;
}

export const buildAggregationSelections = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  params: ParsedAggregationParams
): AggregationSelections => {
  const columns = getTableColumns(schema);
  const groupByColumns: Record<string, AnyColumn> = {};
  const aggregateColumns: Record<string, SQL> = {};

  for (const field of params.groupBy) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid groupBy field: ${field}`);
    }
    groupByColumns[field] = column;
  }

  for (const field of params.sum) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid sum field: ${field}`);
    }
    aggregateColumns[`sum_${field}`] = sum(column);
  }

  for (const field of params.avg) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid avg field: ${field}`);
    }
    aggregateColumns[`avg_${field}`] = avg(column);
  }

  for (const field of params.min) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid min field: ${field}`);
    }
    aggregateColumns[`min_${field}`] = min(column);
  }

  for (const field of params.max) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid max field: ${field}`);
    }
    aggregateColumns[`max_${field}`] = max(column);
  }

  if (params.count) {
    aggregateColumns["count"] = count();
  }

  return { groupByColumns, aggregateColumns };
};

export const transformAggregationResults = (
  results: Record<string, unknown>[],
  params: ParsedAggregationParams
): AggregationResult => {
  const groups = results.map((row) => {
    const key: Record<string, unknown> | null =
      params.groupBy.length > 0
        ? params.groupBy.reduce(
            (acc, field) => {
              acc[field] = row[field];
              return acc;
            },
            {} as Record<string, unknown>
          )
        : null;

    const group: AggregationResult["groups"][number] = { key };

    if (params.count && "count" in row) {
      group.count = Number(row.count);
    }

    if (params.sum.length > 0) {
      group.sum = {};
      for (const field of params.sum) {
        const value = row[`sum_${field}`];
        if (value !== null && value !== undefined) {
          group.sum[field] = Number(value);
        }
      }
    }

    if (params.avg.length > 0) {
      group.avg = {};
      for (const field of params.avg) {
        const value = row[`avg_${field}`];
        if (value !== null && value !== undefined) {
          group.avg[field] = Number(value);
        }
      }
    }

    if (params.min.length > 0) {
      group.min = {};
      for (const field of params.min) {
        const value = row[`min_${field}`];
        if (value !== null && value !== undefined) {
          group.min[field] = typeof value === "number" ? value : String(value);
        }
      }
    }

    if (params.max.length > 0) {
      group.max = {};
      for (const field of params.max) {
        const value = row[`max_${field}`];
        if (value !== null && value !== undefined) {
          group.max[field] = typeof value === "number" ? value : String(value);
        }
      }
    }

    return group;
  });

  return { groups };
};

// Order-independent fingerprint of an aggregation result, used by live
// aggregate subscriptions to decide whether the result actually changed. A
// `GROUP BY` without `ORDER BY` may return groups in a different order across
// executions, so comparing the raw serialization would resend identical
// results. Each group's own fields are emitted in a fixed order (groupBy /
// sum / avg / ... arrays), so only the group array order needs normalizing.
export const canonicalizeAggregation = (result: AggregationResult): string => {
  const groupKeys = result.groups
    .map((group) => JSON.stringify(group))
    .sort();
  return JSON.stringify(groupKeys);
};

export const createQueryHelper = <TConfig extends TableConfig>(
  schema: Table<TConfig>
) => {
  return {
    parseSelect,

    validateFields: (fields: string[]) => validateFields(schema, fields),

    buildProjection: (fields?: string[]) => buildProjection(schema, fields),

    applyProjection,

    parseAggregationParams,

    buildAggregationSelections: (params: ParsedAggregationParams) =>
      buildAggregationSelections(schema, params),

    transformAggregationResults,

    hasAggregation: (query: Record<string, unknown>): boolean => {
      return !!(
        query.groupBy ||
        query.sum ||
        query.avg ||
        query.min ||
        query.max ||
        query.count === "true" ||
        query.count === true
      );
    },

    getValidFields: (): string[] => Object.keys(getTableColumns(schema)),
  };
};

export const mergeProjections = (
  ...projections: (string[] | undefined)[]
): string[] | undefined => {
  const merged = new Set<string>();
  let hasProjection = false;

  for (const projection of projections) {
    if (projection) {
      hasProjection = true;
      for (const field of projection) {
        merged.add(field);
      }
    }
  }

  return hasProjection ? Array.from(merged) : undefined;
};

export const isFieldIncluded = (
  field: string,
  projection?: string[]
): boolean => {
  if (!projection) return true;
  return projection.includes(field);
};
