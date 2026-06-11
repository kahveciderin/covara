import { z } from "zod";
import { Table, TableConfig, getTableColumns } from "drizzle-orm";
import {
  ResourceCapabilities,
  FieldPolicies,
  ProcedureDefinition,
  ETagResourceConfig,
  CustomOperator,
} from "@/resource/types";
import { COVARA_VERSION } from "@/middleware/versioning";

export interface OpenAPIV3Document {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecurityScheme>;
    responses?: Record<string, ResponseObject>;
    parameters?: Record<string, ParameterObject>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  parameters?: ParameterObject[];
}

export interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  example?: unknown;
}

export interface MediaTypeObject {
  schema: SchemaObject;
  example?: unknown;
  examples?: Record<string, { summary?: string; value: unknown }>;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface HeaderObject {
  schema: SchemaObject;
  description?: string;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, MediaTypeObject>;
  headers?: Record<string, HeaderObject>;
}

export interface SchemaObject {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  nullable?: boolean;
  description?: string;
  enum?: unknown[];
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
}

export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  description?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
}

export interface RelationInfo {
  name: string;
  resource: string;
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  nullable?: boolean;
}

export interface RegisteredResource {
  name: string;
  path: string;
  schema: Table<TableConfig>;
  capabilities?: ResourceCapabilities;
  fields?: FieldPolicies;
  procedures?: Record<string, ProcedureDefinition>;
  idField?: string;
  relations?: RelationInfo[];
  etag?: ETagResourceConfig;
  customOperators?: Record<string, CustomOperator>;
}

export interface OpenAPIConfig {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
  securitySchemes?: Record<string, SecurityScheme>;
  basePath?: string;
}

const mapDrizzleTypeToOpenAPI = (
  columnType: string
): { type: SchemaObject["type"]; format?: string } => {
  const type = columnType.toLowerCase();

  if (type.includes("int") || type.includes("serial")) {
    return { type: "integer" };
  }
  if (type.includes("float") || type.includes("double") || type.includes("decimal") || type.includes("numeric")) {
    return { type: "number" };
  }
  if (type.includes("bool")) {
    return { type: "boolean" };
  }
  if (type.includes("timestamp") || type.includes("datetime")) {
    return { type: "string", format: "date-time" };
  }
  if (type.includes("date")) {
    return { type: "string", format: "date" };
  }
  if (type.includes("time")) {
    return { type: "string", format: "time" };
  }
  if (type.includes("json") || type.includes("jsonb")) {
    return { type: "object" };
  }
  if (type.includes("uuid")) {
    return { type: "string", format: "uuid" };
  }

  return { type: "string" };
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

const generateSchemaFromDrizzle = <TConfig extends TableConfig>(
  schema: Table<TConfig> | Record<string, unknown>,
  readableFields?: string[]
): SchemaObject => {
  const columns = getSchemaColumns(schema);
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  if (!columns) {
    return { type: "object", properties: {} };
  }

  for (const [name, column] of Object.entries(columns)) {
    if (readableFields && !readableFields.includes(name)) {
      continue;
    }

    const col = column as {
      dataType?: string;
      notNull?: boolean;
      columnType?: string;
      enumValues?: readonly string[];
    };
    const columnType = col.dataType ?? col.columnType ?? "string";
    const { type, format } = mapDrizzleTypeToOpenAPI(columnType);

    const prop: SchemaObject = { type };
    if (format) {
      prop.format = format;
    }

    if (col.enumValues && col.enumValues.length > 0) {
      prop.type = "string";
      prop.format = undefined;
      prop.enum = [...col.enumValues];
    }

    if (!col.notNull) {
      prop.nullable = true;
    } else {
      required.push(name);
    }

    properties[name] = prop;
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
};

const FILTER_OPERATORS_DOC = [
  "Equality: `==`, `!=`, `=ieq=`, `=ine=` (case-insensitive)",
  "Comparison: `>`, `>=`, `<`, `<=` (aliases `=gt=`, `=ge=`, `=lt=`, `=le=`)",
  "Set membership: `=in=`, `=out=` (comma-separated values)",
  "Pattern: `%=` / `!%=` (LIKE / NOT LIKE), `=ilike=`, `=nilike=`",
  "Substring: `=contains=`, `=icontains=`, `=startswith=`, `=istartswith=`, `=endswith=`, `=iendswith=`",
  "Null/empty: `=isnull=`, `=isempty=`",
  "Range: `=between=`, `=nbetween=`",
  "Regex: `=regex=`, `=iregex=`",
  "Length: `=length=`, `=minlength=`, `=maxlength=`",
  "Boolean: `==true`, `==false`",
].join("; ");

const FILTER_COMBINATORS_DOC =
  "Combinators: `;` (AND), `,` (OR), `()` (grouping).";

const FILTER_EXAMPLE = 'status=="active";age=gt=18,name=contains="jo"';

const buildFilterDescription = (
  customOperators?: Record<string, CustomOperator>
): string => {
  let description =
    `RSQL filter expression. Operators: ${FILTER_OPERATORS_DOC}. ` +
    `${FILTER_COMBINATORS_DOC}`;
  const customNames = customOperators ? Object.keys(customOperators) : [];
  if (customNames.length > 0) {
    description += ` Custom operators: ${customNames.map((n) => `\`${n}\``).join(", ")}.`;
  }
  description += ` Example: ${FILTER_EXAMPLE}`;
  return description;
};

const buildFilterParameter = (
  customOperators?: Record<string, CustomOperator>
): ParameterObject => ({
  name: "filter",
  in: "query",
  description: buildFilterDescription(customOperators),
  schema: { type: "string" },
  example: FILTER_EXAMPLE,
});

const commonParameters: Record<string, ParameterObject> = {
  cursor: {
    name: "cursor",
    in: "query",
    description: "Pagination cursor",
    schema: { type: "string" },
  },
  limit: {
    name: "limit",
    in: "query",
    description: "Number of items to return",
    schema: { type: "integer", format: "int32" },
  },
  orderBy: {
    name: "orderBy",
    in: "query",
    description: "Field to order by (format: field:direction)",
    schema: { type: "string" },
  },
  select: {
    name: "select",
    in: "query",
    description: "Comma-separated list of fields to return",
    schema: { type: "string" },
  },
  totalCount: {
    name: "totalCount",
    in: "query",
    description: "Include total count in response",
    schema: { type: "boolean" },
  },
};

const zodToSchemaObject = (
  schema: z.ZodSchema | undefined,
  fallback: SchemaObject
): SchemaObject => {
  if (!schema) {
    return fallback;
  }
  try {
    const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
      string,
      unknown
    >;
    delete jsonSchema.$schema;
    return jsonSchema as SchemaObject;
  } catch {
    return fallback;
  }
};

const ifMatchParameter: ParameterObject = {
  name: "If-Match",
  in: "header",
  description:
    "ETag value for optimistic concurrency control. The request fails with 412 if the current ETag does not match.",
  schema: { type: "string" },
};

const ifNoneMatchParameter: ParameterObject = {
  name: "If-None-Match",
  in: "header",
  description:
    "ETag value. Returns 304 Not Modified if the current ETag matches.",
  schema: { type: "string" },
};

const etagHeader: HeaderObject = {
  schema: { type: "string" },
  description: "Entity tag for the current representation.",
};

const preconditionFailedResponse: ResponseObject = {
  description: "Precondition failed: the If-Match ETag did not match.",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
    },
  },
};

const notModifiedResponse: ResponseObject = {
  description: "Not modified: the If-None-Match ETag matched.",
};

const problemDetailSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
  },
  required: ["type", "title", "status"],
};

const addResourcePaths = (
  spec: OpenAPIV3Document,
  resource: RegisteredResource,
  basePath: string = ""
): void => {
  const { name, path, schema, capabilities, fields, procedures, etag, customOperators } = resource;
  const resourcePath = `${basePath}${path}`;
  const resourceSchema = generateSchemaFromDrizzle(schema, fields?.readable);
  const schemaRef = `#/components/schemas/${name}`;
  const hasEtag = !!etag;
  const filterParameter = buildFilterParameter(customOperators);

  spec.components!.schemas![name] = resourceSchema;
  spec.components!.schemas![`${name}Input`] = generateSchemaFromDrizzle(schema, fields?.writable);

  spec.paths[resourcePath] = {
    get: {
      summary: `List ${name}`,
      operationId: `list${name}`,
      tags: [name],
      parameters: [
        filterParameter,
        commonParameters.cursor!,
        commonParameters.limit!,
        commonParameters.orderBy!,
        commonParameters.select!,
        commonParameters.totalCount!,
      ],
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: schemaRef } },
                  nextCursor: { type: "string", nullable: true },
                  hasMore: { type: "boolean" },
                  totalCount: { type: "integer", nullable: true },
                },
              },
            },
          },
        },
        "400": {
          description: "Bad request",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableCreate !== false) {
    spec.paths[resourcePath]!.post = {
      summary: `Create ${name}`,
      operationId: `create${name}`,
      tags: [name],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "201": {
          description: "Created",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          ...(hasEtag ? { headers: { ETag: etagHeader } } : {}),
        },
        "400": {
          description: "Validation error",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    };
  }

  const idPath = `${resourcePath}/{id}`;
  spec.paths[idPath] = {
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: `${name} ID`,
      },
    ],
    get: {
      summary: `Get ${name} by ID`,
      operationId: `get${name}`,
      tags: [name],
      parameters: hasEtag
        ? [commonParameters.select!, ifNoneMatchParameter]
        : [commonParameters.select!],
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          ...(hasEtag ? { headers: { ETag: etagHeader } } : {}),
        },
        ...(hasEtag ? { "304": notModifiedResponse } : {}),
        "404": {
          description: "Not found",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableUpdate !== false) {
    spec.paths[idPath]!.patch = {
      summary: `Update ${name}`,
      operationId: `update${name}`,
      tags: [name],
      ...(hasEtag ? { parameters: [ifMatchParameter] } : {}),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          ...(hasEtag ? { headers: { ETag: etagHeader } } : {}),
        },
        "404": { description: "Not found" },
        ...(hasEtag ? { "412": preconditionFailedResponse } : {}),
      },
    };

    spec.paths[idPath]!.put = {
      summary: `Replace ${name}`,
      operationId: `replace${name}`,
      tags: [name],
      ...(hasEtag ? { parameters: [ifMatchParameter] } : {}),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "200": {
          description: "Replaced",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          ...(hasEtag ? { headers: { ETag: etagHeader } } : {}),
        },
        "404": { description: "Not found" },
        ...(hasEtag ? { "412": preconditionFailedResponse } : {}),
      },
    };
  }

  if (capabilities?.enableDelete !== false) {
    spec.paths[idPath]!.delete = {
      summary: `Delete ${name}`,
      operationId: `delete${name}`,
      tags: [name],
      ...(hasEtag ? { parameters: [ifMatchParameter] } : {}),
      responses: {
        "204": { description: "Deleted" },
        "404": { description: "Not found" },
        ...(hasEtag ? { "412": preconditionFailedResponse } : {}),
      },
    };
  }

  spec.paths[`${resourcePath}/count`] = {
    get: {
      summary: `Count ${name}`,
      operationId: `count${name}`,
      tags: [name],
      parameters: [filterParameter],
      responses: {
        "200": {
          description: "Count response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableAggregations !== false) {
    spec.paths[`${resourcePath}/aggregate`] = {
      get: {
        summary: `Aggregate ${name}`,
        operationId: `aggregate${name}`,
        tags: [name],
        parameters: [
          filterParameter,
          { name: "groupBy", in: "query", schema: { type: "string" } },
          { name: "sum", in: "query", schema: { type: "string" } },
          { name: "avg", in: "query", schema: { type: "string" } },
          { name: "min", in: "query", schema: { type: "string" } },
          { name: "max", in: "query", schema: { type: "string" } },
          { name: "count", in: "query", schema: { type: "boolean" } },
        ],
        responses: {
          "200": {
            description: "Aggregation response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    groups: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "object", nullable: true },
                          count: { type: "integer" },
                          sum: { type: "object" },
                          avg: { type: "object" },
                          min: { type: "object" },
                          max: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  if (capabilities?.enableSubscribe !== false) {
    spec.paths[`${resourcePath}/subscribe`] = {
      get: {
        summary: `Subscribe to ${name} changes`,
        description:
          "Server-Sent Events stream of changelog events. Each event has a type of " +
          "`existing`, `added`, `changed`, `removed`, or `invalidate`, plus a monotonic " +
          "sequence number for reliable delivery and reconnection.",
        operationId: `subscribe${name}`,
        tags: [name],
        parameters: [
          filterParameter,
          {
            name: "include",
            in: "query",
            schema: { type: "string" },
            description:
              "Relations to include, e.g. `relation(filter:value;limit:10)`.",
          },
          {
            name: "resumeFrom",
            in: "query",
            schema: { type: "integer" },
            description:
              "Sequence number to resume from after a disconnect (catch-up replay).",
          },
          {
            name: "skipExisting",
            in: "query",
            schema: { type: "boolean" },
            description:
              "If true, skip the initial `existing` snapshot events and only stream subsequent changes.",
          },
        ],
        responses: {
          "200": {
            description: "Server-Sent Events stream of changelog events.",
            headers: {
              "Content-Type": {
                schema: { type: "string", enum: ["text/event-stream"] },
                description: "Always `text/event-stream`.",
              },
            },
            content: {
              "text/event-stream": {
                schema: {
                  type: "object",
                  description: "A single SSE changelog event payload.",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["existing", "added", "changed", "removed", "invalidate"],
                    },
                    seq: { type: "integer", description: "Monotonic sequence number." },
                    data: { $ref: schemaRef },
                  },
                  required: ["type", "seq"],
                },
              },
            },
          },
        },
      },
    };
  }

  if (procedures) {
    for (const [procName, proc] of Object.entries(procedures)) {
      const inputSchema = zodToSchemaObject(proc.input, { type: "object" });
      const outputSchema = zodToSchemaObject(proc.output, { type: "object" });
      spec.paths[`${resourcePath}/rpc/${procName}`] = {
        post: {
          summary: `Call ${procName} procedure`,
          description: `RPC procedure \`${procName}\` on ${name}.`,
          operationId: `${name}_${procName}`,
          tags: [name],
          requestBody: {
            required: !!proc.input,
            content: {
              "application/json": {
                schema: inputSchema,
              },
            },
          },
          responses: {
            "200": {
              description: "Procedure response",
              content: {
                "application/json": {
                  schema: outputSchema,
                },
              },
            },
            "400": {
              description: "Validation error",
              content: {
                "application/problem+json": {
                  schema: { $ref: "#/components/schemas/ProblemDetail" },
                },
              },
            },
          },
        },
      };
    }
  }
};

export const generateOpenAPISpec = (
  resources: RegisteredResource[],
  config: OpenAPIConfig = {}
): OpenAPIV3Document => {
  const spec: OpenAPIV3Document = {
    openapi: "3.0.3",
    info: {
      title: config.title ?? "Covara API",
      version: config.version ?? COVARA_VERSION,
      description: config.description,
    },
    servers: config.servers,
    paths: {},
    components: {
      schemas: {
        ProblemDetail: problemDetailSchema,
      },
      securitySchemes: config.securitySchemes ?? {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
    tags: resources.map((r) => ({ name: r.name })),
  };

  for (const resource of resources) {
    addResourcePaths(spec, resource, config.basePath);
  }

  return spec;
};

export const serveOpenAPI = (
  resources: RegisteredResource[],
  config: OpenAPIConfig = {}
) => {
  let cachedSpec: OpenAPIV3Document | null = null;

  return {
    getSpec: () => {
      if (!cachedSpec) {
        cachedSpec = generateOpenAPISpec(resources, config);
      }
      return cachedSpec;
    },
    invalidateCache: () => {
      cachedSpec = null;
    },
  };
};
