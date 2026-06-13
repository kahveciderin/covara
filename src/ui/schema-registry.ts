import { Table, TableConfig, getTableColumns, AnyColumn } from "drizzle-orm";
import { ResourceConfig, DrizzleDatabase, RelationsConfig, FieldPolicies, ResourceCapabilities, ScopeConfig } from "@/resource/types";
import { createScopeResolver, ScopeResolver } from "@/auth/scope";

export interface SchemaRegistryEntry {
  name: string;
  schema: Table<TableConfig>;
  db: DrizzleDatabase;
  idColumn: AnyColumn;
  mountPath?: string;
  config: {
    relations?: RelationsConfig;
    auth?: ResourceConfig<TableConfig, Table<TableConfig>>["auth"];
    batch?: ResourceConfig<TableConfig, Table<TableConfig>>["batch"];
    capabilities?: ResourceCapabilities;
    sseEnabled?: boolean;
    procedures?: string[];
    generatedFields?: string[];
    fields?: FieldPolicies;
    isFileResource?: boolean;
  };
}

export interface ColumnInfo {
  name: string;
  type: string;
  isPrimary: boolean;
  isNullable: boolean;
  hasDefault: boolean;
  isGenerated: boolean;
}

export interface SchemaInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string;
  relations: string[];
  procedures: string[];
  isFileResource?: boolean;
}

const schemaRegistry = new Map<string, SchemaRegistryEntry>();

export const registerResourceSchema = (
  name: string,
  schema: Table<TableConfig>,
  db: DrizzleDatabase,
  idColumn: AnyColumn,
  config: SchemaRegistryEntry["config"]
): void => {
  schemaRegistry.set(name, { name, schema, db, idColumn, config });
};

export const unregisterResourceSchema = (name: string): void => {
  schemaRegistry.delete(name);
};

export const setResourceMountPath = (name: string, mountPath: string): void => {
  const entry = schemaRegistry.get(name);
  if (entry && !entry.mountPath) {
    entry.mountPath = mountPath;
  }
};

export const setResourceFileFlag = (name: string, isFileResource: boolean): void => {
  const entry = schemaRegistry.get(name);
  if (entry) {
    entry.config.isFileResource = isFileResource;
  }
};

const normalizeResourceName = (name: string): string => {
  return name.startsWith('/') ? name : '/' + name;
};

const extractTableName = (path: string): string => {
  // Extract the last segment of the path as the potential table name
  // e.g., "api/items" -> "items", "/api/v1/users" -> "users"
  const segments = path.replace(/^\/+/, '').split('/');
  return segments[segments.length - 1];
};

const getRegistryEntry = (name: string): SchemaRegistryEntry | null => {
  // Try exact match first
  let entry = schemaRegistry.get(name);
  if (entry) return entry;

  // Try with normalized name (add leading slash if missing)
  const normalized = normalizeResourceName(name);
  entry = schemaRegistry.get(normalized);
  if (entry) return entry;

  // Try without leading slash if it has one
  if (name.startsWith('/')) {
    entry = schemaRegistry.get(name.slice(1));
    if (entry) return entry;
  }

  // Try extracting the table name from the path
  // e.g., "api/items" -> "items", "/api/categories" -> "categories"
  const tableName = extractTableName(name);
  if (tableName && tableName !== name) {
    entry = schemaRegistry.get(tableName);
    if (entry) return entry;
  }

  return null;
};

export const getResourceSchema = (name: string): SchemaRegistryEntry | null => {
  return getRegistryEntry(name);
};

export const getResourceScopeResolver = (name: string): ScopeResolver | null => {
  const entry = getRegistryEntry(name);
  if (!entry) return null;
  return createScopeResolver(entry.config.auth as ScopeConfig | undefined, entry.name);
};

export const getAllResourceSchemas = (): SchemaRegistryEntry[] => {
  return Array.from(schemaRegistry.values());
};

export interface ResourceDisplayInfo {
  name: string;
  mountPath?: string;
  fields: string[];
  capabilities: {
    enableCreate?: boolean;
    enableUpdate?: boolean;
    enableDelete?: boolean;
    enableSubscriptions?: boolean;
    enableAggregations?: boolean;
  };
  auth?: {
    public?: { read?: boolean; subscribe?: boolean };
    hasReadScope?: boolean;
    hasCreateScope?: boolean;
    hasUpdateScope?: boolean;
    hasDeleteScope?: boolean;
  };
  procedures?: string[];
}

export const getAllResourcesForDisplay = (): ResourceDisplayInfo[] => {
  const results: ResourceDisplayInfo[] = [];

  for (const entry of schemaRegistry.values()) {
    const columns = getTableColumns(entry.schema);
    const fields = Object.keys(columns);
    const caps = entry.config.capabilities;
    const auth = entry.config.auth;

    // Convert auth config to display format
    let authDisplay: ResourceDisplayInfo['auth'];
    if (auth) {
      const publicConfig = auth.public;
      authDisplay = {
        public: typeof publicConfig === 'boolean'
          ? { read: publicConfig, subscribe: publicConfig }
          : publicConfig,
        hasReadScope: !!auth.read || !!auth.scope,
        hasCreateScope: !!auth.create,
        hasUpdateScope: !!auth.update,
        hasDeleteScope: !!auth.delete,
      };
    }

    results.push({
      name: entry.name,
      mountPath: entry.mountPath,
      fields,
      capabilities: {
        enableCreate: caps?.enableCreate,
        enableUpdate: caps?.enableUpdate,
        enableDelete: caps?.enableDelete,
        enableSubscriptions: caps?.enableSubscribe ?? entry.config.sseEnabled,
        enableAggregations: caps?.enableAggregations,
      },
      auth: authDisplay,
      procedures: entry.config.procedures,
    });
  }

  return results;
};

export const getSchemaInfo = (name: string): SchemaInfo | null => {
  const entry = getRegistryEntry(name);
  if (!entry) return null;

  const columns = getTableColumns(entry.schema);
  const generatedFields = entry.config.generatedFields ?? [];

  const columnInfos: ColumnInfo[] = Object.entries(columns).map(
    ([colName, column]) => {
      const col = column as unknown as {
        primary?: boolean;
        notNull?: boolean;
        hasDefault?: boolean;
        columnType?: string;
        dataType?: string;
      };

      return {
        name: colName,
        type: col.dataType ?? col.columnType ?? "unknown",
        isPrimary: col.primary ?? false,
        isNullable: !col.notNull,
        hasDefault: col.hasDefault ?? false,
        isGenerated: generatedFields.includes(colName),
      };
    }
  );

  const primaryKey =
    columnInfos.find((c) => c.isPrimary)?.name ?? Object.keys(columns)[0];

  const relations = entry.config.relations
    ? Object.keys(entry.config.relations)
    : [];

  const procedures = entry.config.procedures ?? [];

  return {
    name: entry.name,
    columns: columnInfos,
    primaryKey,
    relations,
    procedures,
    isFileResource: entry.config.isFileResource,
  };
};

export const getAllSchemaInfos = (): SchemaInfo[] => {
  const schemas: SchemaInfo[] = [];
  for (const name of schemaRegistry.keys()) {
    const info = getSchemaInfo(name);
    if (info) schemas.push(info);
  }
  return schemas;
};

export const clearSchemaRegistry = (): void => {
  schemaRegistry.clear();
};

export interface RelationInfo {
  name: string;
  resource: string;
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  nullable?: boolean;
}

export interface OpenAPIResource {
  name: string;
  path: string;
  schema: Table<TableConfig>;
  capabilities?: ResourceCapabilities;
  fields?: FieldPolicies;
  idField?: string;
  relations?: RelationInfo[];
}

export const getResourcesForOpenAPI = (pathPrefix?: string): OpenAPIResource[] => {
  const resources: OpenAPIResource[] = [];

  for (const entry of schemaRegistry.values()) {
    // Use captured mount path if available, otherwise fall back to prefix + name
    const path = entry.mountPath ?? (pathPrefix ? `${pathPrefix}/${entry.name}` : `/${entry.name}`);

    // Extract relation info
    const relations: RelationInfo[] | undefined = entry.config.relations
      ? Object.entries(entry.config.relations).map(([name, rel]) => {
          // Determine if nullable based on relation type
          const isNullable = rel.type === "belongsTo" || rel.type === "hasOne";
          return {
            name,
            resource: rel.resource,
            type: rel.type,
            nullable: isNullable,
          };
        })
      : undefined;

    resources.push({
      name: entry.name,
      path,
      schema: entry.schema,
      capabilities: entry.config.capabilities,
      fields: entry.config.fields,
      idField: entry.idColumn.name,
      relations,
    });
  }

  return resources;
};
