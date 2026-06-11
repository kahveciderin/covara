import { Hono } from "hono";
import { Table, TableConfig, getTableColumns } from "drizzle-orm";
import { ResourceCapabilities, FieldPolicies } from "@/resource/types";
import { CONCAVE_VERSION } from "@/middleware/versioning";
import { generateOpenAPISpec, RegisteredResource, OpenAPIConfig } from "./generator";
import { getResourcesForOpenAPI } from "@/ui/schema-registry";

export interface RelationSchemaInfo {
  name: string;
  resource: string;
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  nullable?: boolean;
}

export interface ResourceSchemaInfo {
  name: string;
  path: string;
  fields: FieldSchemaInfo[];
  relations?: RelationSchemaInfo[];
  capabilities: ResourceCapabilities;
  fieldPolicies?: FieldPolicies;
  procedures: string[];
}

export interface FieldSchemaInfo {
  name: string;
  type: TypeInfo;
  nullable: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  defaultValue?: unknown;
  description?: string;
}

export interface TypeInfo {
  kind: "primitive" | "array" | "object" | "enum" | "union";
  primitive?: "string" | "number" | "boolean" | "integer" | "datetime" | "date" | "time" | "uuid" | "json";
  items?: TypeInfo;
  properties?: Record<string, TypeInfo>;
  enumValues?: string[];
  unionTypes?: TypeInfo[];
}

export interface ConcaveSchema {
  version: string;
  resources: ResourceSchemaInfo[];
  timestamp: string;
}

const mapDrizzleTypeToTypeInfo = (columnType: string): TypeInfo => {
  const type = columnType.toLowerCase();

  if (type.includes("serial")) {
    return { kind: "primitive", primitive: "integer" };
  }
  if (type.includes("int")) {
    return { kind: "primitive", primitive: "integer" };
  }
  if (type.includes("float") || type.includes("double") || type.includes("decimal") || type.includes("numeric")) {
    return { kind: "primitive", primitive: "number" };
  }
  if (type.includes("bool")) {
    return { kind: "primitive", primitive: "boolean" };
  }
  if (type.includes("timestamp") || type.includes("datetime")) {
    return { kind: "primitive", primitive: "datetime" };
  }
  if (type.includes("date")) {
    return { kind: "primitive", primitive: "date" };
  }
  if (type.includes("time")) {
    return { kind: "primitive", primitive: "time" };
  }
  if (type.includes("uuid")) {
    return { kind: "primitive", primitive: "uuid" };
  }
  if (type.includes("json") || type.includes("jsonb")) {
    return { kind: "primitive", primitive: "json" };
  }
  if (type.includes("array")) {
    return { kind: "array", items: { kind: "primitive", primitive: "json" } };
  }

  return { kind: "primitive", primitive: "string" };
};

const typeInfoToTSType = (typeInfo: TypeInfo): string => {
  if (typeInfo.kind === "primitive") {
    switch (typeInfo.primitive) {
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "datetime":
      case "date":
      case "time":
      case "uuid":
      case "string":
        return "string";
      case "json":
        return "Record<string, unknown>";
      default:
        return "string";
    }
  }
  if (typeInfo.kind === "array") {
    const itemType = typeInfo.items ? typeInfoToTSType(typeInfo.items) : "unknown";
    return `${itemType}[]`;
  }
  if (typeInfo.kind === "object") {
    return "Record<string, unknown>";
  }
  if (typeInfo.kind === "enum" && typeInfo.enumValues) {
    return typeInfo.enumValues.map(v => `"${v}"`).join(" | ");
  }
  if (typeInfo.kind === "union" && typeInfo.unionTypes) {
    return typeInfo.unionTypes.map(typeInfoToTSType).join(" | ");
  }
  return "unknown";
};

const getSchemaColumns = <TConfig extends TableConfig>(
  schema: Table<TConfig> | Record<string, unknown>
): Record<string, unknown> | undefined => {
  try {
    const columns = getTableColumns(schema as Table<TConfig>);
    if (columns && Object.keys(columns).length > 0) {
      return columns;
    }
  } catch {
    // Fall through to mock handling
  }

  if (typeof schema === "object" && schema !== null) {
    const entries = Object.entries(schema).filter(
      ([key, value]) =>
        key !== "_" &&
        typeof value === "object" &&
        value !== null &&
        ("dataType" in value || "columnType" in value || "notNull" in value)
    );
    if (entries.length > 0) {
      return Object.fromEntries(entries);
    }
  }

  return undefined;
};

export const extractSchemaInfo = <TConfig extends TableConfig>(
  schema: Table<TConfig> | Record<string, unknown>
): FieldSchemaInfo[] => {
  const columns = getSchemaColumns(schema);
  const fields: FieldSchemaInfo[] = [];

  if (!columns) {
    return fields;
  }

  for (const [name, column] of Object.entries(columns)) {
    const col = column as {
      dataType?: string;
      notNull?: boolean;
      columnType?: string;
      primary?: boolean;
      primaryKey?: boolean;
      autoIncrement?: boolean;
      hasDefault?: boolean;
      default?: unknown;
    };
    const columnType = col.dataType ?? col.columnType ?? "string";
    const isPrimary = col.primary || col.primaryKey || name === "id";
    const isAutoIncrement = col.autoIncrement || columnType.toLowerCase().includes("serial");

    fields.push({
      name,
      type: mapDrizzleTypeToTypeInfo(columnType),
      nullable: !col.notNull,
      primaryKey: isPrimary || undefined,
      autoIncrement: isAutoIncrement || undefined,
      defaultValue: col.hasDefault ? col.default : undefined,
    });
  }

  return fields;
};

export const buildConcaveSchema = (
  resources: RegisteredResource[]
): ConcaveSchema => {
  return {
    version: CONCAVE_VERSION,
    resources: resources.map((r) => ({
      name: r.name,
      path: r.path,
      fields: extractSchemaInfo(r.schema),
      relations: r.relations?.map((rel) => ({
        name: rel.name,
        resource: rel.resource,
        type: rel.type,
        nullable: rel.nullable,
      })),
      capabilities: r.capabilities ?? {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      fieldPolicies: r.fields,
      procedures: r.procedures ? Object.keys(r.procedures) : [],
    })),
    timestamp: new Date().toISOString(),
  };
};

export const generateTypeScriptTypes = (schema: ConcaveSchema): string => {
  let output = `// Generated by Concave v${schema.version}\n`;
  output += `// Generated at ${schema.timestamp}\n\n`;

  for (const resource of schema.resources) {
    output += `export interface ${resource.name} {\n`;
    for (const field of resource.fields) {
      const tsType = typeInfoToTSType(field.type);
      const nullSuffix = field.nullable ? " | null" : "";
      output += `  ${field.name}: ${tsType}${nullSuffix};\n`;
    }
    output += `}\n\n`;

    const autoFields = resource.fields
      .filter(f => f.primaryKey || f.autoIncrement)
      .map(f => `"${f.name}"`)
      .join(" | ");
    const omitType = autoFields ? `Omit<${resource.name}, ${autoFields}>` : resource.name;
    output += `export type ${resource.name}Input = ${omitType};\n`;
    output += `export type ${resource.name}Update = Partial<${resource.name}Input>;\n\n`;
  }

  output += `export interface ConcaveClient {\n`;
  for (const resource of schema.resources) {
    const lowerName = resource.name.charAt(0).toLowerCase() + resource.name.slice(1);
    output += `  ${lowerName}: ResourceClient<${resource.name}>;\n`;
  }
  output += `}\n\n`;

  output += `export interface ResourceClient<T extends { id: string }> {\n`;
  output += `  list(options?: ListOptions): Promise<PaginatedResponse<T>>;\n`;
  output += `  get(id: string, options?: GetOptions): Promise<T>;\n`;
  output += `  count(filter?: string): Promise<number>;\n`;
  output += `  aggregate(options: AggregateOptions): Promise<AggregationResponse>;\n`;
  output += `  create(data: Omit<T, "id">, options?: CreateOptions): Promise<T>;\n`;
  output += `  update(id: string, data: Partial<T>, options?: UpdateOptions): Promise<T>;\n`;
  output += `  delete(id: string): Promise<void>;\n`;
  output += `  subscribe(options?: SubscribeOptions, callbacks?: SubscriptionCallbacks<T>): Subscription<T>;\n`;
  output += `  rpc<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;\n`;
  output += `}\n\n`;

  output += `export interface ListOptions {\n`;
  output += `  filter?: string;\n`;
  output += `  select?: string[];\n`;
  output += `  cursor?: string;\n`;
  output += `  limit?: number;\n`;
  output += `  orderBy?: string;\n`;
  output += `  totalCount?: boolean;\n`;
  output += `}\n\n`;

  output += `export interface GetOptions {\n`;
  output += `  select?: string[];\n`;
  output += `}\n\n`;

  output += `export interface CreateOptions {\n`;
  output += `  idempotencyKey?: string;\n`;
  output += `}\n\n`;

  output += `export interface UpdateOptions {\n`;
  output += `  ifMatch?: string;\n`;
  output += `}\n\n`;

  output += `export interface SubscribeOptions {\n`;
  output += `  filter?: string;\n`;
  output += `  resumeFrom?: number;\n`;
  output += `}\n\n`;

  output += `export interface AggregateOptions {\n`;
  output += `  filter?: string;\n`;
  output += `  groupBy?: string[];\n`;
  output += `  count?: boolean;\n`;
  output += `  sum?: string[];\n`;
  output += `  avg?: string[];\n`;
  output += `  min?: string[];\n`;
  output += `  max?: string[];\n`;
  output += `}\n\n`;

  output += `export interface PaginatedResponse<T> {\n`;
  output += `  items: T[];\n`;
  output += `  nextCursor: string | null;\n`;
  output += `  hasMore: boolean;\n`;
  output += `  totalCount?: number;\n`;
  output += `}\n\n`;

  output += `export interface AggregationResponse {\n`;
  output += `  groups: Array<{\n`;
  output += `    key: Record<string, unknown> | null;\n`;
  output += `    count?: number;\n`;
  output += `    sum?: Record<string, number>;\n`;
  output += `    avg?: Record<string, number>;\n`;
  output += `    min?: Record<string, number | string>;\n`;
  output += `    max?: Record<string, number | string>;\n`;
  output += `  }>;\n`;
  output += `}\n\n`;

  output += `export interface Subscription<T> {\n`;
  output += `  readonly items: T[];\n`;
  output += `  unsubscribe(): void;\n`;
  output += `  reconnect(): void;\n`;
  output += `}\n\n`;

  output += `export interface SubscriptionCallbacks<T> {\n`;
  output += `  onAdded?: (item: T) => void;\n`;
  output += `  onChanged?: (item: T, previousId?: string) => void;\n`;
  output += `  onRemoved?: (id: string) => void;\n`;
  output += `  onInvalidate?: (reason?: string) => void;\n`;
  output += `  onError?: (error: Error) => void;\n`;
  output += `}\n`;

  return output;
};

export interface ConcaveRouterConfig extends OpenAPIConfig {
  pathPrefix?: string;
}

export function createConcaveRouter(config?: ConcaveRouterConfig): Hono;
export function createConcaveRouter(resources: RegisteredResource[], openApiConfig?: OpenAPIConfig): Hono;
export function createConcaveRouter(
  resourcesOrConfig?: RegisteredResource[] | ConcaveRouterConfig,
  openApiConfig?: OpenAPIConfig
): Hono {
  const router = new Hono();

  // Determine if using auto-discovery or explicit resources
  const isAutoDiscovery = !Array.isArray(resourcesOrConfig);
  const config: ConcaveRouterConfig = isAutoDiscovery
    ? (resourcesOrConfig as ConcaveRouterConfig) ?? {}
    : openApiConfig ?? {};

  const getResources = (): RegisteredResource[] => {
    if (!isAutoDiscovery) {
      return resourcesOrConfig as RegisteredResource[];
    }
    // Auto-discover from schema registry (uses captured mount paths when available)
    return getResourcesForOpenAPI(config.pathPrefix);
  };

  router.get("/schema", (c) => {
    const resources = getResources();
    const schema = buildConcaveSchema(resources);
    return c.json(schema);
  });

  router.get("/schema/typescript", (c) => {
    const resources = getResources();
    const schema = buildConcaveSchema(resources);
    const types = generateTypeScriptTypes(schema);
    c.header("Content-Type", "text/typescript");
    return c.body(types);
  });

  router.get("/openapi.json", (c) => {
    const resources = getResources();
    const spec = generateOpenAPISpec(resources, config);
    return c.json(spec);
  });

  router.get("/openapi.yaml", (c) => {
    try {
      const resources = getResources();
      const spec = generateOpenAPISpec(resources, config);
      const yaml = JSON.stringify(spec, null, 2);
      c.header("Content-Type", "text/yaml");
      return c.body(yaml);
    } catch {
      return c.json({ error: "Failed to generate YAML" }, 500);
    }
  });

  router.get("/health", (c) => {
    const resources = getResources();
    return c.json({
      status: "ok",
      version: CONCAVE_VERSION,
      timestamp: new Date().toISOString(),
      resources: resources.map((r) => r.name),
    });
  });

  return router;
}

export const SCHEMA_ENDPOINT = "/__concave";
