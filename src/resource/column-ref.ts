import { AnyColumn, Table, TableConfig, getTableColumns } from "drizzle-orm";
import type {
  ResourceConfig,
  FilterConfig,
  ResourceSearchConfig,
  SoftDeleteConfig,
  RelationConfig,
  SearchFieldConfig,
} from "./types";

/**
 * A reference to a table column in resource config. Prefer passing the Drizzle
 * column object (e.g. `todos.userId`), the same way `id` is given. Passing the
 * column name as a string is supported but **deprecated** — it isn't checked
 * against the schema and will be removed in a future major.
 */
export type ColumnRef = AnyColumn | string;

const isColumn = (ref: ColumnRef): ref is AnyColumn => typeof ref !== "string";

/** Resolve a column reference (column object or deprecated string) to its name. */
export const columnName = (ref: ColumnRef): string =>
  isColumn(ref) ? ref.name : ref;

/** Resolve an array of column references to their names. */
export function columnNames(refs: ColumnRef[]): string[];
export function columnNames(refs: ColumnRef[] | undefined): string[] | undefined;
export function columnNames(refs?: ColumnRef[]): string[] | undefined {
  return refs?.map(columnName);
}

// Resolve a column reference to the schema's JS PROPERTY key — the key space used
// by drizzle rows, request bodies, drizzle-zod schemas, `getTableColumns`, and
// drizzle `.set()`/`.values()`. Config sections (fields, generatedFields,
// softDelete, etc.) are compared against that data, so a column declared with a
// distinct DB name (e.g. `orgId: text("org_id")`) must be normalized to `orgId`,
// not `org_id`. A column object is resolved by identity; a string is kept if it is
// already a property key, mapped from a DB name when it matches one, else left
// as-is (unknown/deprecated).
export const columnPropertyKey = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  ref: ColumnRef
): string => makePropertyResolver(schema)(ref);

const makePropertyResolver = <TConfig extends TableConfig>(
  schema?: Table<TConfig>
): ((ref: ColumnRef) => string) => {
  if (!schema) return columnName;
  const columns = getTableColumns(schema);
  const byIdentity = new Map<unknown, string>();
  const byDbName = new Map<string, string>();
  const propertyKeys = new Set<string>();
  for (const [key, col] of Object.entries(columns)) {
    byIdentity.set(col, key);
    byDbName.set((col as AnyColumn & { name: string }).name, key);
    propertyKeys.add(key);
  }
  return (ref: ColumnRef): string => {
    if (typeof ref !== "string") {
      return byIdentity.get(ref) ?? (ref as AnyColumn & { name: string }).name;
    }
    if (propertyKeys.has(ref)) return ref;
    return byDbName.get(ref) ?? ref;
  };
};

// Input (public) variants of the column-name config sections that additionally
// accept Drizzle column objects. They are normalized to the plain string-based
// config types before the resource layer consumes them.

export interface ETagResourceConfigInput {
  versionField?: ColumnRef;
  updatedAtField?: ColumnRef;
  idField?: ColumnRef;
  algorithm?: "weak" | "strong";
}

export interface FieldPoliciesInput {
  readable?: ColumnRef[];
  writable?: ColumnRef[];
  filterable?: ColumnRef[];
  sortable?: ColumnRef[];
  aggregatable?: {
    groupBy?: ColumnRef[];
    metrics?: ColumnRef[];
  };
}

export type FilterConfigInput = Omit<FilterConfig, "allowedFields"> & {
  allowedFields?: ColumnRef[];
};

export type ResourceSearchConfigInput = Omit<ResourceSearchConfig, "fields"> & {
  fields?: ColumnRef[] | Record<string, SearchFieldConfig>;
};

export type SoftDeleteConfigInput = Omit<SoftDeleteConfig, "field"> & {
  field: ColumnRef;
};

export type RelationConfigInput = Omit<RelationConfig, "defaultSelect"> & {
  defaultSelect?: ColumnRef[];
};

export interface RelationsConfigInput {
  [relationName: string]: RelationConfigInput;
}

/**
 * Public resource config: identical to {@link ResourceConfig} except every field
 * that names a column also accepts the Drizzle column object (preferred). Use
 * {@link normalizeResourceConfig} to convert it to the string-based config the
 * rest of the resource layer consumes.
 */
export type ResourceConfigInput<
  TConfig extends TableConfig,
  TTable extends Table<TConfig>,
> = Omit<
  ResourceConfig<TConfig, TTable>,
  "etag" | "fields" | "filter" | "generatedFields" | "search" | "softDelete" | "relations"
> & {
  etag?: ETagResourceConfigInput;
  fields?: FieldPoliciesInput;
  filter?: FilterConfigInput;
  generatedFields?: ColumnRef[];
  search?: ResourceSearchConfigInput;
  softDelete?: SoftDeleteConfigInput;
  relations?: RelationsConfigInput;
};

/**
 * Convert a public {@link ResourceConfigInput} (which may carry Drizzle column
 * objects) to the string-based {@link ResourceConfig} the resource layer uses.
 * Does not mutate the input — only the touched sub-objects are shallow-cloned.
 */
export const normalizeResourceConfig = <
  TConfig extends TableConfig,
  TTable extends Table<TConfig>,
>(
  config: ResourceConfigInput<TConfig, TTable>,
  // The resource's table. When provided, column references normalize to the JS
  // property key (matching rows/bodies/schemas); required for correctness with
  // columns whose DB name differs from their property. Omitted only for legacy
  // callers, which fall back to the raw column name.
  schema?: TTable
): ResourceConfig<TConfig, TTable> => {
  const out: any = { ...config };
  const resolve = makePropertyResolver(schema);
  const resolveMany = (refs?: ColumnRef[]): string[] | undefined =>
    refs?.map(resolve);

  if (config.etag) {
    const e = config.etag;
    out.etag = {
      ...e,
      versionField: e.versionField === undefined ? undefined : resolve(e.versionField),
      updatedAtField: e.updatedAtField === undefined ? undefined : resolve(e.updatedAtField),
      idField: e.idField === undefined ? undefined : resolve(e.idField),
    };
  }

  if (config.softDelete) {
    out.softDelete = { ...config.softDelete, field: resolve(config.softDelete.field) };
  }

  if (config.fields) {
    const f = config.fields;
    out.fields = {
      ...f,
      readable: resolveMany(f.readable),
      writable: resolveMany(f.writable),
      filterable: resolveMany(f.filterable),
      sortable: resolveMany(f.sortable),
      aggregatable: f.aggregatable
        ? {
            groupBy: resolveMany(f.aggregatable.groupBy),
            metrics: resolveMany(f.aggregatable.metrics),
          }
        : undefined,
    };
  }

  if (config.filter?.allowedFields) {
    out.filter = { ...config.filter, allowedFields: resolveMany(config.filter.allowedFields) };
  }

  if (config.generatedFields) {
    out.generatedFields = resolveMany(config.generatedFields);
  }

  // Search field list (array form). The record form is keyed by name and left
  // as-is (object keys can't be column objects).
  if (config.search && Array.isArray(config.search.fields)) {
    out.search = { ...config.search, fields: resolveMany(config.search.fields) };
  }

  if (config.relations) {
    const relations: Record<string, unknown> = {};
    for (const [name, relation] of Object.entries(config.relations)) {
      relations[name] = relation.defaultSelect
        ? { ...relation, defaultSelect: resolveMany(relation.defaultSelect) }
        : relation;
    }
    out.relations = relations;
  }

  return out as ResourceConfig<TConfig, TTable>;
};
