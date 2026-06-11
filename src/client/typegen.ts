import type { CovaraSchema, TypeInfo, FieldSchemaInfo, ResourceSchemaInfo } from "../openapi/schema";
import { fetchEnvSchema, generateEnvTypeScript, PublicEnvSchema } from "./env";

export interface TypegenOptions {
  serverUrl: string;
  output?: "typescript" | "dart" | "json";
  namespace?: string;
  includeClient?: boolean;
  envPath?: string;
  includeEnv?: boolean;
}

export interface TypegenResult {
  code: string;
  schema: CovaraSchema;
  envSchema?: PublicEnvSchema;
  generatedAt: string;
}

export const fetchSchema = async (serverUrl: string): Promise<CovaraSchema> => {
  const url = serverUrl.replace(/\/$/, "") + "/__covara/schema";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

export const generateTypes = async (options: TypegenOptions): Promise<TypegenResult> => {
  const schema = await fetchSchema(options.serverUrl);
  const output = options.output ?? "typescript";
  const includeEnv = options.includeEnv ?? true;

  let envSchema: PublicEnvSchema | undefined;
  if (includeEnv && output === "typescript") {
    try {
      envSchema = await fetchEnvSchema(
        options.serverUrl,
        options.envPath ?? "/api/env"
      );
    } catch {
      // Env endpoint not available, skip env types
    }
  }

  let code: string;
  switch (output) {
    case "typescript":
      code = generateTypeScript(schema, options, envSchema);
      break;
    case "dart":
      code = generateDart(schema, options);
      break;
    case "json":
      code = JSON.stringify({ ...schema, env: envSchema }, null, 2);
      break;
    default:
      throw new Error(`Unsupported output format: ${output}`);
  }

  return {
    code,
    schema,
    envSchema,
    generatedAt: new Date().toISOString(),
  };
};

const typeInfoToTS = (typeInfo: TypeInfo): string => {
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
    const itemType = typeInfo.items ? typeInfoToTS(typeInfo.items) : "unknown";
    return `${itemType}[]`;
  }
  if (typeInfo.kind === "object") {
    return "Record<string, unknown>";
  }
  if (typeInfo.kind === "enum" && typeInfo.enumValues) {
    return typeInfo.enumValues.map(v => `"${v}"`).join(" | ");
  }
  if (typeInfo.kind === "union" && typeInfo.unionTypes) {
    return typeInfo.unionTypes.map(typeInfoToTS).join(" | ");
  }
  return "unknown";
};

const typeInfoToDart = (typeInfo: TypeInfo): string => {
  if (typeInfo.kind === "primitive") {
    switch (typeInfo.primitive) {
      case "integer":
        return "int";
      case "number":
        return "double";
      case "boolean":
        return "bool";
      case "datetime":
        return "DateTime";
      case "date":
      case "time":
      case "uuid":
      case "string":
        return "String";
      case "json":
        return "Map<String, dynamic>";
      default:
        return "String";
    }
  }
  if (typeInfo.kind === "array") {
    const itemType = typeInfo.items ? typeInfoToDart(typeInfo.items) : "dynamic";
    return `List<${itemType}>`;
  }
  if (typeInfo.kind === "object") {
    return "Map<String, dynamic>";
  }
  if (typeInfo.kind === "enum" && typeInfo.enumValues) {
    return "String";
  }
  if (typeInfo.kind === "union" && typeInfo.unionTypes) {
    return "dynamic";
  }
  return "dynamic";
};

const isNumericType = (typeInfo: TypeInfo): boolean => {
  if (typeInfo.kind === "primitive") {
    return typeInfo.primitive === "integer" || typeInfo.primitive === "number";
  }
  return false;
};

const isStringType = (typeInfo: TypeInfo): boolean => {
  if (typeInfo.kind === "primitive") {
    return (
      typeInfo.primitive === "string" ||
      typeInfo.primitive === "uuid" ||
      typeInfo.primitive === "datetime" ||
      typeInfo.primitive === "date" ||
      typeInfo.primitive === "time"
    );
  }
  return false;
};

const isComparableType = (typeInfo: TypeInfo): boolean => {
  if (typeInfo.kind === "primitive") {
    return (
      typeInfo.primitive === "integer" ||
      typeInfo.primitive === "number" ||
      typeInfo.primitive === "string" ||
      typeInfo.primitive === "uuid" ||
      typeInfo.primitive === "datetime" ||
      typeInfo.primitive === "date" ||
      typeInfo.primitive === "time"
    );
  }
  return false;
};

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isValidIdentifier = (name: string): boolean => IDENTIFIER_RE.test(name);

const propertyName = (name: string): string =>
  isValidIdentifier(name) ? name : JSON.stringify(name);

const sanitizeTypeName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_$]+(.)?/g, (_match, next: string | undefined) =>
    next ? next.toUpperCase() : ""
  );
  if (cleaned.length === 0) return "_Resource";
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

const resourceKeyName = (name: string): string => {
  const sanitized = sanitizeTypeName(name);
  return sanitized.charAt(0).toLowerCase() + sanitized.slice(1);
};

const isOptionalInputField = (field: FieldSchemaInfo): boolean =>
  field.nullable === true ||
  field.defaultValue !== undefined ||
  field.primaryKey === true ||
  field.autoIncrement === true;

const generateTypeScript = (
  schema: CovaraSchema,
  options: TypegenOptions,
  envSchema?: PublicEnvSchema
): string => {
  const ns = options.namespace;
  let output = `// Generated by Covara Typegen v${schema.version}\n`;
  output += `// Server: ${options.serverUrl}\n`;
  output += `// Generated at: ${schema.timestamp}\n\n`;

  // Import types from the library - this is critical for type inference to work
  if (options.includeClient !== false) {
    output += `import type { ResourceClient, CovaraClient } from "covara/client";\n\n`;
  }

  if (ns) {
    output += `export namespace ${ns} {\n`;
  }

  const indent = ns ? "  " : "";

  // Build a map of resource paths to (sanitized) type names for relation type lookup
  const resourceNameByPath = new Map<string, string>();
  for (const resource of schema.resources) {
    const typeName = sanitizeTypeName(resource.name);
    // Map both the path (e.g., "/categories") and the resource name (e.g., "categories")
    resourceNameByPath.set(resource.path, typeName);
    resourceNameByPath.set(resource.name, typeName);
    resourceNameByPath.set(resource.name.toLowerCase(), typeName);
    // Also map without leading slash
    if (resource.path.startsWith("/")) {
      resourceNameByPath.set(resource.path.slice(1), typeName);
    }
  }

  const relatedTypeNameFor = (relationResource: string): string =>
    resourceNameByPath.get(relationResource) ??
    resourceNameByPath.get(relationResource.toLowerCase()) ??
    sanitizeTypeName(relationResource);

  for (const resource of schema.resources) {
    const typeName = sanitizeTypeName(resource.name);
    output += `${indent}export interface ${typeName} {\n`;
    for (const field of resource.fields) {
      const tsType = typeInfoToTS(field.type);
      const nullSuffix = field.nullable ? " | null" : "";
      output += `${indent}  ${propertyName(field.name)}: ${tsType}${nullSuffix};\n`;
    }
    output += `${indent}}\n\n`;

    // Input type: auto-increment fields are server-generated (excluded);
    // primary keys, nullable fields, and fields with defaults are optional.
    const inputFields = resource.fields.filter(f => !f.autoIncrement);
    output += `${indent}export type ${typeName}Input = {\n`;
    for (const field of inputFields) {
      const tsType = typeInfoToTS(field.type);
      const nullSuffix = field.nullable ? " | null" : "";
      const optional = isOptionalInputField(field) ? "?" : "";
      output += `${indent}  ${propertyName(field.name)}${optional}: ${tsType}${nullSuffix};\n`;
    }
    output += `${indent}};\n`;
    output += `${indent}export type ${typeName}Update = Partial<${typeName}Input>;\n\n`;

    // Generate field metadata types for type-safe queries
    const allFields = resource.fields.map(f => JSON.stringify(f.name)).join(" | ");
    output += `${indent}export type ${typeName}Fields = ${allFields || "never"};\n`;

    const numericFields = resource.fields
      .filter(f => isNumericType(f.type))
      .map(f => JSON.stringify(f.name))
      .join(" | ");
    output += `${indent}export type ${typeName}NumericFields = ${numericFields || "never"};\n`;

    const comparableFields = resource.fields
      .filter(f => isComparableType(f.type))
      .map(f => JSON.stringify(f.name))
      .join(" | ");
    output += `${indent}export type ${typeName}ComparableFields = ${comparableFields || "never"};\n`;

    const stringFields = resource.fields
      .filter(f => isStringType(f.type))
      .map(f => JSON.stringify(f.name))
      .join(" | ");
    output += `${indent}export type ${typeName}StringFields = ${stringFields || "never"};\n\n`;

    // Generate Relations type and WithRelations type if the resource has relations
    if (resource.relations && resource.relations.length > 0) {
      // Generate Relations interface - maps relation names to their types
      output += `${indent}export interface ${typeName}Relations {\n`;
      for (const relation of resource.relations) {
        const relatedTypeName = relatedTypeNameFor(relation.resource);

        if (relation.type === "hasMany" || relation.type === "manyToMany") {
          output += `${indent}  ${propertyName(relation.name)}: ${relatedTypeName}[];\n`;
        } else {
          output += `${indent}  ${propertyName(relation.name)}: ${relatedTypeName} | null;\n`;
        }
      }
      output += `${indent}}\n\n`;

      // Generate relation names type for type-safe include()
      const relationNames = resource.relations.map(r => JSON.stringify(r.name)).join(" | ");
      output += `${indent}export type ${typeName}RelationNames = ${relationNames};\n\n`;

      // Generate WithRelations type (all relations included)
      output += `${indent}export interface ${typeName}WithRelations extends ${typeName} {\n`;
      for (const relation of resource.relations) {
        const relatedTypeName = relatedTypeNameFor(relation.resource);

        if (relation.type === "hasMany" || relation.type === "manyToMany") {
          output += `${indent}  ${propertyName(relation.name)}?: ${relatedTypeName}[];\n`;
        } else {
          output += `${indent}  ${propertyName(relation.name)}?: ${relatedTypeName} | null;\n`;
        }
      }
      output += `${indent}}\n\n`;

      // Generate helper type to pick specific relations
      output += `${indent}export type ${typeName}With<K extends keyof ${typeName}Relations> = ${typeName} & { [P in K]?: ${typeName}Relations[P] };\n\n`;
    }
  }

  if (options.includeClient !== false) {
    output += generateTSClientTypes(schema, indent);
  }

  if (envSchema && envSchema.fields.length > 0) {
    output += `${indent}// Public Environment Variables\n`;
    const envType = generateEnvTypeScript(envSchema);
    if (ns) {
      output += envType
        .split("\n")
        .map((line) => (line ? `${indent}${line}` : line))
        .join("\n");
    } else {
      output += envType;
    }
    output += "\n";
  }

  if (ns) {
    output += `}\n`;
  }

  return output;
};

const generateTSClientTypes = (schema: CovaraSchema, indent: string): string => {
  let output = "";

  // Generate path constants
  // Uses the path reported by the server schema as-is (the server reports the
  // actual mount path when it is known).
  output += `${indent}// Resource path constants\n`;
  output += `${indent}export const ResourcePaths = {\n`;
  for (const resource of schema.resources) {
    const lowerName = resourceKeyName(resource.name);
    const path = resource.path.startsWith("/") ? resource.path : `/${resource.path}`;
    output += `${indent}  ${lowerName}: "${path}" as const,\n`;
  }
  output += `${indent}} as const;\n\n`;

  // Generate LiveQuery interface for fluent API with type-safe includes and select
  output += `${indent}// LiveQuery - fluent query builder that can be passed to useLiveList\n`;
  output += `${indent}// Tracks included relations AND selected fields at the type level for automatic type inference\n`;
  output += `${indent}// Also provides access to the underlying ResourceClient for direct operations\n`;
  output += `${indent}export interface LiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T> {\n`;
  output += `${indent}  readonly _type: T;\n`;
  output += `${indent}  readonly _relations: Relations;\n`;
  output += `${indent}  readonly _included: Included;\n`;
  output += `${indent}  readonly _selected: Selected;\n`;
  output += `${indent}  readonly _path: string;\n`;
  output += `${indent}  readonly _options: LiveQueryOptions;\n`;
  output += `${indent}  readonly _client: ResourceClient<T>;\n`;
  output += `${indent}  // Fluent query methods\n`;
  output += `${indent}  filter(filter: string): LiveQuery<T, Relations, Included, Selected>;\n`;
  output += `${indent}  where(filter: string): LiveQuery<T, Relations, Included, Selected>;\n`;
  output += `${indent}  orderBy(orderBy: string): LiveQuery<T, Relations, Included, Selected>;\n`;
  output += `${indent}  limit(limit: number): LiveQuery<T, Relations, Included, Selected>;\n`;
  output += `${indent}  select<K extends keyof T>(...fields: K[]): LiveQuery<T, Relations, Included, K | 'id'>;\n`;
  output += `${indent}  include<K extends keyof Relations>(...relations: K[]): LiveQuery<T, Relations, Included & Pick<Relations, K>, Selected>;\n`;
  output += `${indent}  // ResourceClient methods for direct operations\n`;
  output += `${indent}  query(): ReturnType<ResourceClient<T>["query"]>;\n`;
  output += `${indent}  list(options?: Parameters<ResourceClient<T>["list"]>[0]): ReturnType<ResourceClient<T>["list"]>;\n`;
  output += `${indent}  get(id: string, options?: Parameters<ResourceClient<T>["get"]>[1]): ReturnType<ResourceClient<T>["get"]>;\n`;
  output += `${indent}  search(query: string, options?: Parameters<ResourceClient<T>["search"]>[1]): ReturnType<ResourceClient<T>["search"]>;\n`;
  output += `${indent}  create(data: Parameters<ResourceClient<T>["create"]>[0], options?: Parameters<ResourceClient<T>["create"]>[1]): ReturnType<ResourceClient<T>["create"]>;\n`;
  output += `${indent}  update(id: string, data: Parameters<ResourceClient<T>["update"]>[1], options?: Parameters<ResourceClient<T>["update"]>[2]): ReturnType<ResourceClient<T>["update"]>;\n`;
  output += `${indent}  delete(id: string, options?: Parameters<ResourceClient<T>["delete"]>[1]): ReturnType<ResourceClient<T>["delete"]>;\n`;
  output += `${indent}  subscribe(options?: Parameters<ResourceClient<T>["subscribe"]>[0], callbacks?: Parameters<ResourceClient<T>["subscribe"]>[1]): ReturnType<ResourceClient<T>["subscribe"]>;\n`;
  output += `${indent}}\n\n`;

  output += `${indent}export interface LiveQueryOptions {\n`;
  output += `${indent}  filter?: string;\n`;
  output += `${indent}  orderBy?: string;\n`;
  output += `${indent}  limit?: number;\n`;
  output += `${indent}  select?: string[];\n`;
  output += `${indent}  include?: string;\n`;
  output += `${indent}}\n\n`;

  // Generate typed resources interface with LiveQuery support
  output += `${indent}// Typed resources accessor with fluent query builder\n`;
  output += `${indent}// Each resource returns a LiveQuery that can be chained and passed to useLiveList\n`;
  output += `${indent}export interface TypedResources {\n`;
  for (const resource of schema.resources) {
    const lowerName = resourceKeyName(resource.name);
    const typeName = sanitizeTypeName(resource.name);
    const hasRelations = resource.relations && resource.relations.length > 0;
    const relationsType = hasRelations ? `${typeName}Relations` : "{}";
    output += `${indent}  ${lowerName}: LiveQuery<${typeName}, ${relationsType}>;\n`;
  }
  output += `${indent}}\n\n`;

  // Generate typed client interface extending CovaraClient
  output += `${indent}// Typed client with resources accessor\n`;
  output += `${indent}export interface TypedCovaraClient extends CovaraClient {\n`;
  output += `${indent}  resources: TypedResources;\n`;
  output += `${indent}}\n\n`;

  // Generate createTypedClient factory function
  output += `${indent}// ============================================================\n`;
  output += `${indent}// Typed Client Factory\n`;
  output += `${indent}// ============================================================\n`;
  output += `${indent}//\n`;
  output += `${indent}// Usage:\n`;
  output += `${indent}//   import { getOrCreateClient } from "covara/client";\n`;
  output += `${indent}//   import { createTypedClient } from "./api-types";\n`;
  output += `${indent}//\n`;
  output += `${indent}//   const client = createTypedClient(getOrCreateClient({ baseUrl: location.origin }));\n`;
  output += `${indent}//\n`;
  output += `${indent}//   // Now use typed resources - types are inferred automatically:\n`;

  for (const resource of schema.resources) {
    const lowerName = resourceKeyName(resource.name);
    output += `${indent}//   const { items } = useLiveList(client.resources.${lowerName});  // items: ${sanitizeTypeName(resource.name)}[]\n`;
  }

  output += `${indent}//\n`;
  output += `${indent}// LiveQuery implementation - fluent query builder with type tracking\n`;
  output += `${indent}// Also proxies ResourceClient methods for direct operations\n`;
  output += `${indent}function createLiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T>(\n`;
  output += `${indent}  baseClient: CovaraClient,\n`;
  output += `${indent}  path: string,\n`;
  output += `${indent}  options: LiveQueryOptions = {}\n`;
  output += `${indent}): LiveQuery<T, Relations, Included, Selected> {\n`;
  output += `${indent}  const resourceClient = baseClient.resource<T>(path);\n`;
  output += `${indent}  const query: LiveQuery<T, Relations, Included, Selected> = {\n`;
  output += `${indent}    _type: null as unknown as T,\n`;
  output += `${indent}    _relations: null as unknown as Relations,\n`;
  output += `${indent}    _included: null as unknown as Included,\n`;
  output += `${indent}    _selected: null as unknown as Selected,\n`;
  output += `${indent}    _path: path,\n`;
  output += `${indent}    _options: options,\n`;
  output += `${indent}    _client: resourceClient,\n`;
  output += `${indent}    // Fluent query methods\n`;
  output += `${indent}    filter(filter: string) {\n`;
  output += `${indent}      const combined = options.filter ? \`(\${options.filter});(\${filter})\` : filter;\n`;
  output += `${indent}      return createLiveQuery<T, Relations, Included, Selected>(baseClient, path, { ...options, filter: combined });\n`;
  output += `${indent}    },\n`;
  output += `${indent}    where(filter: string) {\n`;
  output += `${indent}      return this.filter(filter);\n`;
  output += `${indent}    },\n`;
  output += `${indent}    orderBy(orderBy: string) {\n`;
  output += `${indent}      return createLiveQuery<T, Relations, Included, Selected>(baseClient, path, { ...options, orderBy });\n`;
  output += `${indent}    },\n`;
  output += `${indent}    limit(limit: number) {\n`;
  output += `${indent}      return createLiveQuery<T, Relations, Included, Selected>(baseClient, path, { ...options, limit });\n`;
  output += `${indent}    },\n`;
  output += `${indent}    select<K extends keyof T>(...fields: K[]) {\n`;
  output += `${indent}      return createLiveQuery<T, Relations, Included, K | 'id'>(baseClient, path, { ...options, select: fields as string[] }) as LiveQuery<T, Relations, Included, K | 'id'>;\n`;
  output += `${indent}    },\n`;
  output += `${indent}    include<K extends keyof Relations>(...relations: K[]) {\n`;
  output += `${indent}      const includeStr = options.include\n`;
  output += `${indent}        ? \`\${options.include},\${relations.join(',')}\`\n`;
  output += `${indent}        : relations.join(',');\n`;
  output += `${indent}      return createLiveQuery<T, Relations, Included & Pick<Relations, K>, Selected>(baseClient, path, { ...options, include: includeStr });\n`;
  output += `${indent}    },\n`;
  output += `${indent}    // Proxied ResourceClient methods\n`;
  output += `${indent}    query() { return resourceClient.query(); },\n`;
  output += `${indent}    list(opts) { return resourceClient.list(opts); },\n`;
  output += `${indent}    get(id, opts) { return resourceClient.get(id, opts); },\n`;
  output += `${indent}    search(q, opts) { return resourceClient.search(q, opts); },\n`;
  output += `${indent}    create(data, opts) { return resourceClient.create(data, opts); },\n`;
  output += `${indent}    update(id, data, opts) { return resourceClient.update(id, data, opts); },\n`;
  output += `${indent}    delete(id, opts) { return resourceClient.delete(id, opts); },\n`;
  output += `${indent}    subscribe(opts, cbs) { return resourceClient.subscribe(opts, cbs); },\n`;
  output += `${indent}  };\n`;
  output += `${indent}  return query;\n`;
  output += `${indent}}\n\n`;

  output += `${indent}export function createTypedClient(baseClient: CovaraClient): TypedCovaraClient {\n`;
  output += `${indent}  return {\n`;
  output += `${indent}    ...baseClient,\n`;
  output += `${indent}    resources: {\n`;

  for (const resource of schema.resources) {
    const lowerName = resourceKeyName(resource.name);
    const typeName = sanitizeTypeName(resource.name);
    const hasRelations = resource.relations && resource.relations.length > 0;
    const relationsType = hasRelations ? `${typeName}Relations` : "{}";
    output += `${indent}      ${lowerName}: createLiveQuery<${typeName}, ${relationsType}>(baseClient, ResourcePaths.${lowerName}),\n`;
  }

  output += `${indent}    },\n`;
  output += `${indent}  } as TypedCovaraClient;\n`;
  output += `${indent}}\n`;

  return output;
};

const generateDart = (schema: CovaraSchema, options: TypegenOptions): string => {
  let output = `// Generated by Covara Typegen v${schema.version}\n`;
  output += `// Server: ${options.serverUrl}\n`;
  output += `// Generated at: ${schema.timestamp}\n\n`;
  output += `import 'dart:convert';\n\n`;

  for (const resource of schema.resources) {
    output += generateDartClass(resource);
  }

  if (options.includeClient !== false) {
    output += generateDartClientTypes();
  }

  return output;
};

const generateDartClass = (resource: ResourceSchemaInfo): string => {
  const className = sanitizeTypeName(resource.name);
  let output = `class ${className} {\n`;

  for (const field of resource.fields) {
    const dartType = typeInfoToDart(field.type);
    const nullSuffix = field.nullable ? "?" : "";
    output += `  final ${dartType}${nullSuffix} ${field.name};\n`;
  }
  output += `\n`;

  output += `  ${className}({\n`;
  for (const field of resource.fields) {
    const required = !field.nullable && !field.primaryKey && !field.autoIncrement;
    output += `    ${required ? "required " : ""}this.${field.name},\n`;
  }
  output += `  });\n\n`;

  output += `  factory ${className}.fromJson(Map<String, dynamic> json) {\n`;
  output += `    return ${className}(\n`;
  for (const field of resource.fields) {
    const dartType = typeInfoToDart(field.type);
    let converter = `json['${field.name}']`;
    if (dartType === "DateTime") {
      converter = field.nullable
        ? `json['${field.name}'] != null ? DateTime.parse(json['${field.name}']) : null`
        : `DateTime.parse(json['${field.name}'])`;
    } else if (dartType === "int" && field.nullable) {
      converter = `json['${field.name}'] as int?`;
    } else if (dartType === "double" && field.nullable) {
      converter = `(json['${field.name}'] as num?)?.toDouble()`;
    } else if (dartType === "double") {
      converter = `(json['${field.name}'] as num).toDouble()`;
    }
    output += `      ${field.name}: ${converter},\n`;
  }
  output += `    );\n`;
  output += `  }\n\n`;

  output += `  Map<String, dynamic> toJson() {\n`;
  output += `    return {\n`;
  for (const field of resource.fields) {
    const dartType = typeInfoToDart(field.type);
    let value = field.name;
    if (dartType === "DateTime") {
      value = field.nullable ? `${field.name}?.toIso8601String()` : `${field.name}.toIso8601String()`;
    }
    output += `      '${field.name}': ${value},\n`;
  }
  output += `    };\n`;
  output += `  }\n`;

  output += `}\n\n`;

  const inputFields = resource.fields.filter(f => !f.primaryKey && !f.autoIncrement);
  output += `class ${className}Input {\n`;
  for (const field of inputFields) {
    const dartType = typeInfoToDart(field.type);
    const nullSuffix = field.nullable ? "?" : "";
    output += `  final ${dartType}${nullSuffix} ${field.name};\n`;
  }
  output += `\n`;

  output += `  ${className}Input({\n`;
  for (const field of inputFields) {
    const required = !field.nullable;
    output += `    ${required ? "required " : ""}this.${field.name},\n`;
  }
  output += `  });\n\n`;

  output += `  Map<String, dynamic> toJson() {\n`;
  output += `    return {\n`;
  for (const field of inputFields) {
    const dartType = typeInfoToDart(field.type);
    let value = field.name;
    if (dartType === "DateTime") {
      value = field.nullable ? `${field.name}?.toIso8601String()` : `${field.name}.toIso8601String()`;
    }
    output += `      '${field.name}': ${value},\n`;
  }
  output += `    };\n`;
  output += `  }\n`;
  output += `}\n\n`;

  return output;
};

const generateDartClientTypes = (): string => {
  let output = `// Client types\n\n`;

  output += `class ListOptions {\n`;
  output += `  final String? filter;\n`;
  output += `  final List<String>? select;\n`;
  output += `  final String? cursor;\n`;
  output += `  final int? limit;\n`;
  output += `  final String? orderBy;\n`;
  output += `  final bool? totalCount;\n\n`;
  output += `  ListOptions({this.filter, this.select, this.cursor, this.limit, this.orderBy, this.totalCount});\n`;
  output += `}\n\n`;

  output += `class PaginatedResponse<T> {\n`;
  output += `  final List<T> items;\n`;
  output += `  final String? nextCursor;\n`;
  output += `  final bool hasMore;\n`;
  output += `  final int? totalCount;\n\n`;
  output += `  PaginatedResponse({required this.items, this.nextCursor, required this.hasMore, this.totalCount});\n`;
  output += `}\n\n`;

  output += `class SubscribeOptions {\n`;
  output += `  final String? filter;\n`;
  output += `  final int? resumeFrom;\n\n`;
  output += `  SubscribeOptions({this.filter, this.resumeFrom});\n`;
  output += `}\n\n`;

  output += `class AggregateOptions {\n`;
  output += `  final String? filter;\n`;
  output += `  final List<String>? groupBy;\n`;
  output += `  final bool? count;\n`;
  output += `  final List<String>? sum;\n`;
  output += `  final List<String>? avg;\n`;
  output += `  final List<String>? min;\n`;
  output += `  final List<String>? max;\n\n`;
  output += `  AggregateOptions({this.filter, this.groupBy, this.count, this.sum, this.avg, this.min, this.max});\n`;
  output += `}\n\n`;

  return output;
};

export const createTypegenCLI = async (args: string[]): Promise<void> => {
  const serverUrl = args[0];
  const output = (args[1] as TypegenOptions["output"]) ?? "typescript";

  if (!serverUrl) {
    console.error("Usage: covara-typegen <server-url> [typescript|dart|json]");
    process.exit(1);
  }

  try {
    const result = await generateTypes({ serverUrl, output });
    console.log(result.code);
  } catch (error) {
    console.error("Error generating types:", error);
    process.exit(1);
  }
};
