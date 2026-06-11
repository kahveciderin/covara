import type { Context } from "hono";
import { getGlobalSearch, hasGlobalSearch, SearchConfig } from "@/search";
import { ValidationError, SearchError } from "./error";
import { ScopeResolver } from "@/auth/scope";
import { UserContext } from "./types";

const ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?)?$/;

const tryParseDate = (v: unknown): Date | null => {
  if (v instanceof Date) return v;
  if (typeof v === "string" && ISO_DATE_REGEX.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const safeCompare = (a: unknown, b: unknown): number => {
  const aDate = tryParseDate(a);
  const bDate = tryParseDate(b);
  if (aDate && bDate) {
    return aDate.getTime() - bDate.getTime();
  }

  const tryNumber = (v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v === "string") {
      const n = parseFloat(v.trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  const aNum = tryNumber(a);
  const bNum = tryNumber(b);

  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    return aNum - bNum;
  }

  return String(a).localeCompare(String(b));
};

type FilterOperator = (lhs: unknown, rhs: unknown) => boolean;

const operators: Record<string, FilterOperator> = {
  "==": (lhs, rhs) => String(lhs) === String(rhs),
  "!=": (lhs, rhs) => String(lhs) !== String(rhs),
  ">": (lhs, rhs) => safeCompare(lhs, rhs) > 0,
  ">=": (lhs, rhs) => safeCompare(lhs, rhs) >= 0,
  "<": (lhs, rhs) => safeCompare(lhs, rhs) < 0,
  "<=": (lhs, rhs) => safeCompare(lhs, rhs) <= 0,
  "=gt=": (lhs, rhs) => safeCompare(lhs, rhs) > 0,
  "=ge=": (lhs, rhs) => safeCompare(lhs, rhs) >= 0,
  "=lt=": (lhs, rhs) => safeCompare(lhs, rhs) < 0,
  "=le=": (lhs, rhs) => safeCompare(lhs, rhs) <= 0,
  "=isnull=": (lhs, rhs) => {
    const checkNull = String(rhs).toLowerCase() === "true";
    return checkNull
      ? lhs === null || lhs === undefined
      : lhs !== null && lhs !== undefined;
  },
  "=contains=": (lhs, rhs) => String(lhs).includes(String(rhs)),
  "=icontains=": (lhs, rhs) =>
    String(lhs).toLowerCase().includes(String(rhs).toLowerCase()),
  "=startswith=": (lhs, rhs) => String(lhs).startsWith(String(rhs)),
  "=endswith=": (lhs, rhs) => String(lhs).endsWith(String(rhs)),
  "=in=": (lhs, rhs) => {
    const arr = Array.isArray(rhs) ? rhs : [rhs];
    return arr.some((item) => String(item) === String(lhs));
  },
  "=out=": (lhs, rhs) => {
    const arr = Array.isArray(rhs) ? rhs : [rhs];
    return !arr.some((item) => String(item) === String(lhs));
  },
};

interface ParsedCondition {
  field: string;
  operator: string;
  value: unknown;
}

interface ParsedFilter {
  type: "and" | "or" | "condition";
  children?: ParsedFilter[];
  condition?: ParsedCondition;
}

const parseSimpleFilter = (filterStr: string): ParsedFilter | null => {
  filterStr = filterStr.trim();
  if (!filterStr) return null;

  const orParts = splitTopLevel(filterStr, ",");
  if (orParts.length > 1) {
    return {
      type: "or",
      children: orParts.map((p) => parseSimpleFilter(p)!).filter(Boolean),
    };
  }

  const andParts = splitTopLevel(filterStr, ";");
  if (andParts.length > 1) {
    return {
      type: "and",
      children: andParts.map((p) => parseSimpleFilter(p)!).filter(Boolean),
    };
  }

  if (filterStr.startsWith("(") && filterStr.endsWith(")")) {
    return parseSimpleFilter(filterStr.slice(1, -1));
  }

  const condition = parseCondition(filterStr);
  if (condition) {
    return { type: "condition", condition };
  }

  return null;
};

const splitTopLevel = (str: string, delimiter: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;

    if (char === '"' && str[i - 1] !== "\\") {
      inString = !inString;
    }

    if (!inString) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (depth === 0 && str.slice(i, i + delimiter.length) === delimiter) {
        parts.push(current);
        current = "";
        i += delimiter.length - 1;
        continue;
      }
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
};

const parseCondition = (str: string): ParsedCondition | null => {
  str = str.trim();

  for (const op of Object.keys(operators).sort((a, b) => b.length - a.length)) {
    const idx = str.indexOf(op);
    if (idx > 0) {
      const field = str.slice(0, idx).trim();
      const valueStr = str.slice(idx + op.length).trim();

      let value: unknown = valueStr;

      if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
        value = valueStr.slice(1, -1).replace(/\\"/g, '"');
      } else if (valueStr === "true") {
        value = true;
      } else if (valueStr === "false") {
        value = false;
      } else if (valueStr === "null") {
        value = null;
      } else if (!isNaN(Number(valueStr))) {
        value = Number(valueStr);
      } else if (valueStr.startsWith("(") && valueStr.endsWith(")")) {
        value = valueStr
          .slice(1, -1)
          .split(",")
          .map((v) => {
            v = v.trim();
            if (v.startsWith('"') && v.endsWith('"')) {
              return v.slice(1, -1);
            }
            if (!isNaN(Number(v))) return Number(v);
            return v;
          });
      }

      return { field, operator: op, value };
    }
  }

  return null;
};

const executeFilter = (
  filter: ParsedFilter,
  obj: Record<string, unknown>
): boolean => {
  if (filter.type === "and") {
    return filter.children!.every((child) => executeFilter(child, obj));
  }
  if (filter.type === "or") {
    return filter.children!.some((child) => executeFilter(child, obj));
  }
  if (filter.type === "condition" && filter.condition) {
    const { field, operator, value } = filter.condition;
    const lhs = obj[field];
    const op = operators[operator];
    if (!op) return true;
    return op(lhs, value);
  }
  return true;
};

export interface SearchHandlerOptions {
  scopeResolver: ScopeResolver;
  getUser: (c: Context) => UserContext | null;
  filterer: {
    execute: (expr: string, obj: unknown) => boolean;
  };
  maskItem?: (item: Record<string, unknown>) => Record<string, unknown>;
}

export const createSearchHandler = (
  config: SearchConfig,
  tableName: string,
  _primaryKeyName: string,
  options?: SearchHandlerOptions
) => {
  return async (c: Context): Promise<Response> => {
    if (!hasGlobalSearch()) {
      return c.body(null, 404);
    }

    const search = getGlobalSearch();
    const query = c.req.query("q");

    if (!query) {
      throw new ValidationError("Missing query parameter 'q'");
    }

    let authScope: string | null = null;
    if (options) {
      const user = options.getUser(c);
      const scope = await options.scopeResolver.resolve("read", user);
      authScope = scope.toString();
    }

    const indexName = config.indexName ?? tableName;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "") || 20, 100);
    const offset = parseInt(c.req.query("offset") ?? "") || 0;

    let fields: string[] | undefined;
    let fieldWeights: Record<string, number> | undefined;

    if (config.fields) {
      if (Array.isArray(config.fields)) {
        fields = config.fields;
      } else {
        fields = Object.entries(config.fields)
          .filter(([_, cfg]) => cfg.searchable !== false)
          .map(([field]) => field);
        fieldWeights = Object.fromEntries(
          Object.entries(config.fields)
            .filter(([_, cfg]) => cfg.weight !== undefined)
            .map(([field, cfg]) => [field, cfg.weight!])
        );
      }
    }

    const highlightEnabled = c.req.query("highlight") === "true";

    try {
      const result = await search.search(indexName, {
        query,
        fields,
        fieldWeights,
        from: offset,
        size: limit,
        highlight: highlightEnabled,
      });

      let items = result.hits.map((hit) => hit.source);
      const userFilter = c.req.query("filter");

      if (options && authScope && authScope !== "*") {
        let combinedFilter: string;
        if (!userFilter || userFilter.trim() === "") {
          combinedFilter = authScope;
        } else {
          combinedFilter = `(${authScope});(${userFilter})`;
        }

        if (combinedFilter) {
          items = items.filter((item) =>
            options.filterer.execute(combinedFilter, item)
          );
        }
      } else if (userFilter) {
        const filter = parseSimpleFilter(userFilter);
        if (filter) {
          items = items.filter((item) =>
            executeFilter(filter, item as Record<string, unknown>)
          );
        }
      }

      const itemIds = new Set(items.map((item) => String((item as Record<string, unknown>).id)));
      const highlights = highlightEnabled
        ? Object.fromEntries(
            result.hits
              .filter((h) => h.highlights && itemIds.has(String(h.id)))
              .map((h) => [h.id, h.highlights])
          )
        : undefined;

      if (options?.maskItem) {
        items = items.map((item) => options.maskItem!(item as Record<string, unknown>));
      }

      return c.json({
        items,
        total: items.length,
        ...(highlights && Object.keys(highlights).length > 0 && { highlights }),
      });
    } catch (err) {
      const error = err as Error;
      throw new SearchError(`Search failed: ${error.message}`, {
        originalError: error.message,
        index: indexName,
      });
    }
  };
};
