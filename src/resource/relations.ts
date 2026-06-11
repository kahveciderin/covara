import {
  Table,
  TableConfig,
  and,
  eq,
  SQL,
  SQLWrapper,
  AnyColumn,
  getTableColumns,
  inArray,
} from "drizzle-orm";
import { DrizzleDatabase, CustomOperator } from "./types";
import { createResourceFilter } from "./filter";

export type RelationType = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

export interface RelationConfig<
  TSourceConfig extends TableConfig = TableConfig,
  TTargetConfig extends TableConfig = TableConfig,
> {
  resource: string;
  schema: Table<TTargetConfig>;
  type: RelationType;
  foreignKey: AnyColumn;
  references: AnyColumn;
  through?: {
    schema: Table<TableConfig>;
    sourceKey: AnyColumn;
    targetKey: AnyColumn;
  };
  strategy?: "eager" | "lazy";
  defaultSelect?: string[];
  filterable?: boolean;
  subscribeToChanges?: boolean;
  condition?: (
    source: Table<TSourceConfig>,
    target: Table<TTargetConfig>
  ) => SQL;
}

export interface RelationsConfig<TConfig extends TableConfig = TableConfig> {
  [relationName: string]: RelationConfig<TConfig, TableConfig>;
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

const splitTopLevel = (str: string, delimiter: string): string[] => {
  const result: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of str) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;

    if (char === delimiter && depth === 0) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) result.push(current);
  return result;
};

const parseIncludeOptions = (optionsStr: string): Partial<IncludeSpec> => {
  const result: Partial<IncludeSpec> = {};
  const options = optionsStr.split(";");

  for (const opt of options) {
    const colonIndex = opt.indexOf(":");
    if (colonIndex === -1) continue;

    const key = opt.slice(0, colonIndex).trim();
    const value = opt.slice(colonIndex + 1).trim();

    switch (key) {
      case "select":
        result.select = value.split(",").map((s) => s.trim());
        break;
      case "filter":
        result.filter = value;
        break;
      case "limit":
        result.limit = parseInt(value, 10);
        break;
      case "offset":
        result.offset = parseInt(value, 10);
        break;
    }
  }

  return result;
};

const parseIncludePart = (part: string): IncludeSpec => {
  const dotIndex = part.indexOf(".");
  if (dotIndex > 0 && !part.includes("(")) {
    const parent = part.slice(0, dotIndex);
    const child = part.slice(dotIndex + 1);
    return {
      relation: parent,
      nested: [parseIncludePart(child)],
    };
  }

  const parenIndex = part.indexOf("(");
  if (parenIndex > 0) {
    const relation = part.slice(0, parenIndex);
    const optionsStr = part.slice(parenIndex + 1, -1);
    const options = parseIncludeOptions(optionsStr);

    return {
      relation,
      ...options,
    };
  }

  return { relation: part };
};

export const parseInclude = (includeParam?: string): IncludeSpec[] => {
  if (!includeParam) return [];

  const specs: IncludeSpec[] = [];
  const parts = splitTopLevel(includeParam, ",");

  for (const part of parts) {
    specs.push(parseIncludePart(part.trim()));
  }

  return specs;
};

export interface ParsedNestedFilter {
  localFilter: string;
  relationFilters: Map<string, string>;
}

export const parseNestedFilter = (
  filterExpr: string,
  relations: RelationsConfig
): ParsedNestedFilter => {
  const relationFilters = new Map<string, string>();
  const localParts: string[] = [];

  const parts = splitTopLevel(filterExpr, ";");

  for (const part of parts) {
    const match = part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(.+)$/);
    if (match) {
      const [, relationName, nestedExpr] = match;
      if (relations[relationName!]) {
        const existing = relationFilters.get(relationName!) ?? "";
        relationFilters.set(
          relationName!,
          existing ? `${existing};${nestedExpr}` : nestedExpr!
        );
        continue;
      }
    }
    localParts.push(part);
  }

  return {
    localFilter: localParts.join(";"),
    relationFilters,
  };
};

export class RelationLoader<TConfig extends TableConfig> {
  constructor(
    private db: DrizzleDatabase,
    private sourceSchema: Table<TConfig>,
    private relations: RelationsConfig<TConfig>,
    private resourceRegistry: Map<
      string,
      { schema: Table<TableConfig>; config: { relations?: RelationsConfig } }
    >,
    private config: IncludeConfig = {}
  ) {}

  private filterCache = new Map<string, ReturnType<typeof createResourceFilter>>();

  getEagerIncludes(): IncludeSpec[] {
    const specs: IncludeSpec[] = [];
    for (const [name, relation] of Object.entries(this.relations)) {
      if (relation.strategy === "eager") {
        specs.push({ relation: name });
      }
    }
    return specs;
  }

  private buildRelationWhere(
    targetSchema: Table<TableConfig>,
    filterExpr: string | undefined,
    baseCondition: SQLWrapper
  ): SQLWrapper {
    if (!filterExpr) return baseCondition;

    let filter = this.filterCache.get(filterExpr);
    if (!filter) {
      filter = createResourceFilter(
        targetSchema,
        this.config.customOperators ?? {}
      );
      this.filterCache.set(filterExpr, filter);
    }

    return and(baseCondition, filter.convert(filterExpr)) as SQLWrapper;
  }

  async loadRelationsForItem<T extends Record<string, unknown>>(
    item: T,
    includes: IncludeSpec[],
    idColumn: string,
    depth: number = 0
  ): Promise<T & Record<string, unknown>> {
    if (depth > (this.config.maxDepth ?? 3)) {
      return item;
    }

    const result = { ...item };

    for (const include of includes) {
      const relation = this.relations[include.relation];
      if (!relation) continue;

      const related = await this.loadRelation(
        item,
        relation,
        include,
        idColumn,
        depth
      );

      (result as Record<string, unknown>)[include.relation] = related;
    }

    return result;
  }

  async loadRelationsForItems<T extends Record<string, unknown>>(
    items: T[],
    includes: IncludeSpec[],
    idColumn: string,
    depth: number = 0
  ): Promise<(T & Record<string, unknown>)[]> {
    if (items.length === 0 || includes.length === 0) {
      return items as (T & Record<string, unknown>)[];
    }

    if (depth > (this.config.maxDepth ?? 3)) {
      return items as (T & Record<string, unknown>)[];
    }

    const results = items.map((item) => ({ ...item }));

    for (const include of includes) {
      const relation = this.relations[include.relation];
      if (!relation) continue;

      const relatedMap = await this.batchLoadRelation(
        items,
        relation,
        include,
        idColumn,
        depth
      );

      for (const result of results) {
        const id = String(result[idColumn]);
        (result as Record<string, unknown>)[include.relation] =
          relatedMap.get(id) ??
          (relation.type === "hasMany" || relation.type === "manyToMany"
            ? []
            : null);
      }
    }

    return results as (T & Record<string, unknown>)[];
  }

  private async loadRelation(
    item: Record<string, unknown>,
    relation: RelationConfig<TConfig, TableConfig>,
    include: IncludeSpec,
    idColumn: string,
    depth: number
  ): Promise<unknown> {
    const targetSchema = relation.schema;
    const targetColumns = getTableColumns(targetSchema);

    const selectColumns = include.select
      ? Object.fromEntries(
          include.select
            .filter((f) => f in targetColumns)
            .map((f) => [f, targetColumns[f]])
        )
      : targetColumns;

    let query = this.db.select(selectColumns).from(targetSchema);

    switch (relation.type) {
      case "belongsTo": {
        const fkValue = item[
          (relation.foreignKey as AnyColumn & { name: string }).name
        ];
        if (fkValue == null) return null;
        query = query.where(
          this.buildRelationWhere(
            targetSchema,
            include.filter,
            eq(relation.references, fkValue as never)
          )
        ) as never;
        break;
      }
      case "hasOne":
      case "hasMany": {
        const sourceId = item[idColumn];
        query = query.where(
          this.buildRelationWhere(
            targetSchema,
            include.filter,
            eq(relation.foreignKey, sourceId as never)
          )
        ) as never;
        break;
      }
      case "manyToMany": {
        if (!relation.through) {
          throw new Error("manyToMany relation requires through configuration");
        }
        const sourceId = item[idColumn];
        query = this.db
          .select(selectColumns)
          .from(targetSchema)
          .innerJoin(
            relation.through.schema,
            eq(relation.through.targetKey, relation.references)
          )
          .where(
            this.buildRelationWhere(
              targetSchema,
              include.filter,
              eq(relation.through.sourceKey, sourceId as never)
            )
          ) as never;
        break;
      }
    }

    const effectiveLimit =
      include.limit ??
      ((relation.type === "hasMany" || relation.type === "manyToMany") &&
      this.config.defaultLimit
        ? this.config.defaultLimit
        : undefined);

    if (effectiveLimit != null) {
      query = query.limit(effectiveLimit) as never;
    }
    if (include.offset != null && include.offset > 0) {
      query = query.offset(include.offset) as never;
    }

    const results = await query;

    if (include.nested && include.nested.length > 0) {
      const targetResource = this.resourceRegistry.get(relation.resource);
      if (targetResource?.config.relations) {
        const nestedLoader = new RelationLoader(
          this.db,
          targetSchema,
          targetResource.config.relations as RelationsConfig<TableConfig>,
          this.resourceRegistry,
          this.config
        );

        const targetIdColumn =
          (
            relation.references as AnyColumn & { name: string }
          ).name ?? "id";

        if (relation.type === "hasMany" || relation.type === "manyToMany") {
          return nestedLoader.loadRelationsForItems(
            results as Record<string, unknown>[],
            include.nested,
            targetIdColumn,
            depth + 1
          );
        } else {
          return results[0]
            ? nestedLoader.loadRelationsForItem(
                results[0] as Record<string, unknown>,
                include.nested,
                targetIdColumn,
                depth + 1
              )
            : null;
        }
      }
    }

    if (relation.type === "hasMany" || relation.type === "manyToMany") {
      return results;
    }
    return results[0] ?? null;
  }

  private async batchLoadRelation(
    items: Record<string, unknown>[],
    relation: RelationConfig<TConfig, TableConfig>,
    include: IncludeSpec,
    idColumn: string,
    depth: number
  ): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();
    const targetSchema = relation.schema;
    const targetColumns = getTableColumns(targetSchema);

    const sourceIds = items.map((item) => item[idColumn]).filter((id) => id != null);
    if (sourceIds.length === 0) return result;

    const selectColumns = include.select
      ? Object.fromEntries(
          include.select
            .filter((f) => f in targetColumns)
            .map((f) => [f, targetColumns[f]])
        )
      : targetColumns;

    switch (relation.type) {
      case "belongsTo": {
        const fkName = (relation.foreignKey as AnyColumn & { name: string }).name;
        const fkValues = items
          .map((item) => item[fkName])
          .filter((v) => v != null);

        if (fkValues.length === 0) return result;

        const refName = (relation.references as AnyColumn & { name: string }).name;
        const query = this.db
          .select(selectColumns)
          .from(targetSchema)
          .where(
            this.buildRelationWhere(
              targetSchema,
              include.filter,
              inArray(relation.references, fkValues as never[])
            )
          );

        const targetItems = await query;

        const targetMap = new Map<string, unknown>();
        for (const targetItem of targetItems as Record<string, unknown>[]) {
          targetMap.set(String(targetItem[refName]), targetItem);
        }

        for (const item of items) {
          const fkValue = item[fkName];
          if (fkValue != null) {
            result.set(
              String(item[idColumn]),
              targetMap.get(String(fkValue)) ?? null
            );
          }
        }
        break;
      }

      case "hasOne":
      case "hasMany": {
        const perParentLimit =
          relation.type === "hasMany"
            ? include.limit ?? this.config.defaultLimit
            : undefined;

        if (perParentLimit != null || include.offset != null) {
          for (const item of items) {
            const sourceId = item[idColumn];
            if (sourceId == null) continue;

            let perQuery = this.db
              .select(selectColumns)
              .from(targetSchema)
              .where(
                this.buildRelationWhere(
                  targetSchema,
                  include.filter,
                  eq(relation.foreignKey, sourceId as never)
                )
              );

            if (perParentLimit != null) {
              perQuery = perQuery.limit(perParentLimit);
            }
            if (include.offset != null && include.offset > 0) {
              perQuery = perQuery.offset(include.offset);
            }

            const rows = (await perQuery) as Record<string, unknown>[];
            result.set(
              String(sourceId),
              relation.type === "hasOne" ? rows[0] ?? null : rows
            );
          }
          break;
        }

        const query = this.db
          .select({
            ...selectColumns,
            _sourceId: relation.foreignKey,
          })
          .from(targetSchema)
          .where(
            this.buildRelationWhere(
              targetSchema,
              include.filter,
              inArray(relation.foreignKey, sourceIds as never[])
            )
          );

        const targetItems = await query;

        if (relation.type === "hasOne") {
          for (const targetItem of targetItems as Record<string, unknown>[]) {
            const sourceId = String(targetItem._sourceId);
            delete (targetItem as Record<string, unknown>)._sourceId;
            result.set(sourceId, targetItem);
          }
        } else {
          for (const targetItem of targetItems as Record<string, unknown>[]) {
            const sourceId = String(targetItem._sourceId);
            delete (targetItem as Record<string, unknown>)._sourceId;

            if (!result.has(sourceId)) {
              result.set(sourceId, []);
            }
            (result.get(sourceId) as unknown[]).push(targetItem);
          }
        }
        break;
      }

      case "manyToMany": {
        if (!relation.through) break;

        const perParentLimit = include.limit ?? this.config.defaultLimit;

        if (perParentLimit != null || include.offset != null) {
          for (const item of items) {
            const sourceId = item[idColumn];
            if (sourceId == null) continue;

            let perQuery = this.db
              .select(selectColumns)
              .from(targetSchema)
              .innerJoin(
                relation.through.schema,
                eq(relation.through.targetKey, relation.references)
              )
              .where(
                this.buildRelationWhere(
                  targetSchema,
                  include.filter,
                  eq(relation.through.sourceKey, sourceId as never)
                )
              );

            if (perParentLimit != null) {
              perQuery = perQuery.limit(perParentLimit);
            }
            if (include.offset != null && include.offset > 0) {
              perQuery = perQuery.offset(include.offset);
            }

            const rows = (await perQuery) as Record<string, unknown>[];
            result.set(String(sourceId), rows);
          }
          break;
        }

        const query = this.db
          .select({
            ...selectColumns,
            _sourceId: relation.through.sourceKey,
          })
          .from(targetSchema)
          .innerJoin(
            relation.through.schema,
            eq(relation.through.targetKey, relation.references)
          )
          .where(
            this.buildRelationWhere(
              targetSchema,
              include.filter,
              inArray(relation.through.sourceKey, sourceIds as never[])
            )
          );

        const targetItems = await query;

        for (const targetItem of targetItems as Record<string, unknown>[]) {
          const sourceId = String(targetItem._sourceId);
          delete (targetItem as Record<string, unknown>)._sourceId;

          if (!result.has(sourceId)) {
            result.set(sourceId, []);
          }
          (result.get(sourceId) as unknown[]).push(targetItem);
        }
        break;
      }
    }

    if (include.nested && include.nested.length > 0) {
      const targetResource = this.resourceRegistry.get(relation.resource);
      if (targetResource?.config.relations) {
        const nestedLoader = new RelationLoader(
          this.db,
          targetSchema,
          targetResource.config.relations as RelationsConfig<TableConfig>,
          this.resourceRegistry,
          this.config
        );

        const targetIdColumn =
          (relation.references as AnyColumn & { name: string }).name ?? "id";

        for (const [sourceId, related] of result) {
          if (Array.isArray(related)) {
            const withNested = await nestedLoader.loadRelationsForItems(
              related as Record<string, unknown>[],
              include.nested,
              targetIdColumn,
              depth + 1
            );
            result.set(sourceId, withNested);
          } else if (related) {
            const withNested = await nestedLoader.loadRelationsForItem(
              related as Record<string, unknown>,
              include.nested,
              targetIdColumn,
              depth + 1
            );
            result.set(sourceId, withNested);
          }
        }
      }
    }

    return result;
  }
}

export const createRelationLoader = <TConfig extends TableConfig>(
  db: DrizzleDatabase,
  sourceSchema: Table<TConfig>,
  relations: RelationsConfig<TConfig>,
  resourceRegistry: Map<
    string,
    { schema: Table<TableConfig>; config: { relations?: RelationsConfig } }
  >,
  config?: IncludeConfig
): RelationLoader<TConfig> => {
  return new RelationLoader(db, sourceSchema, relations, resourceRegistry, config);
};
